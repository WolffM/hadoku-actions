// Resolves, ONCE, the version every @wolffm/* dependency is bumped to, and
// waits until npmjs can actually serve each one that installs from there.
//
// Why once: `pnpm update --latest` re-read "latest" on every retry, so during a
// publish burst each retry chased a newer release whose tarball was not up yet
// either (cardtable, 2026-11-17: 0.45.106, then 0.45.107, then out of retries).
// The pinned specs this prints are what the update step installs, every attempt.
//
// Why the tarball: npmjs lists a version in its packument minutes before the
// .tgz serves. Measured 2026-11-17, from the registry's publish time to a 404
// still seen on the tarball: rooms-protocol 0.45.106 4m16s, service-kernel
// 0.1.61 3m59s, platform-wire 0.1.33 4m39s, rooms-client 0.45.108 4m49s. The
// 404s are not edge-cached (no cf-cache-status), so polling does no harm.
//
// Env: WAIT_BUDGET_S, POLL_S, RECURSIVE. Writes `specs`, `deadline` and
// `resolved-at` (when "latest" was read; the assert forgives only releases
// published after it) to $GITHUB_OUTPUT.
import { execFile } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'
import { promisify } from 'node:util'

const run = promisify(execFile)
const GH = 'https://npm.pkg.github.com'
const NPMJS = 'https://registry.npmjs.org'
const EXACT = /^\d+\.\d+\.\d+$/

const budget = Number(process.env.WAIT_BUDGET_S)
const poll = Number(process.env.POLL_S)
if (!(budget > 0) || !(poll > 0)) throw new Error('WAIT_BUDGET_S and POLL_S must be positive numbers')
const started = Date.now()
const deadline = started + budget * 1000

async function view(spec, field, registry) {
  try {
    const { stdout } = await run('npm', ['view', spec, field, '--json', `--registry=${registry}`])
    return stdout.trim() ? JSON.parse(stdout) : null
  } catch {
    return null
  }
}

// The manifests the update step will touch: every one under the working
// directory when recursive, else only its own.
const manifests = process.env.RECURSIVE === 'true'
  ? (await run('git', ['ls-files', '*package.json'])).stdout.split('\n').filter(m => m && !m.includes('node_modules'))
  : ['package.json']

// name -> real npmjs name when it is an @hadoku/* alias, else null.
const deps = new Map()
for (const m of manifests) {
  let pkg
  try { pkg = JSON.parse(readFileSync(m, 'utf8')) } catch { continue }
  for (const field of ['dependencies', 'devDependencies']) {
    for (const [name, range] of Object.entries(pkg[field] || {})) {
      if (!name.startsWith('@wolffm/')) continue
      const r = String(range)
      if (r.startsWith('workspace:')) continue
      const alias = (r.match(/^npm:(@hadoku\/[^@]+)@/) || [])[1] || null
      if (deps.has(name) && deps.get(name) !== alias) {
        // One pinned spec cannot keep both forms; no consumer does this today.
        console.log(`::error::${name} is declared both as ${deps.get(name) || 'itself'} and as ${alias || 'itself'}; pick one`)
        process.exit(1)
      }
      deps.set(name, alias)
    }
  }
}

// GitHub Packages is where a release lands first, so its latest is the target
// for both forms. An alias it cannot read falls back to npmjs's own latest.
const specs = []
const awaited = new Map() // "@hadoku/x@1.2.3" -> { real, version }
const pending = new Set() // keys of awaited that npmjs does not serve yet
await Promise.all([...deps].map(async ([name, alias]) => {
  let version = await view(name, 'version', GH)
  if (!version && alias) {
    version = await view(alias, 'version', NPMJS)
    if (version) console.log(`::notice::${name}: GitHub Packages unreadable; targeting npmjs's latest ${alias}@${version}`)
  }
  if (!version) {
    console.log(`::error::${name}: no registry would say what its latest version is`)
    process.exitCode = 1
    return
  }
  specs.push(alias ? `${name}@npm:${alias}@${version}` : `${name}@${version}`)
  if (alias) {
    awaited.set(`${alias}@${version}`, { real: alias, version })
    pending.add(`${alias}@${version}`)
  }
}))
if (process.exitCode) process.exit(process.exitCode)

// Waits until npmjs lists real@version and its tarball answers 200. Then the
// same for every @hadoku/* it pins to an exact version, which pnpm fetches in
// the same install (bomberman, 2026-11-17: platform-wire 0.1.28 under
// game-server 0.1.28, ERR_PNPM_NO_MATCHING_VERSION).
async function served({ real, version }) {
  const tarball = await view(`${real}@${version}`, 'dist.tarball', NPMJS)
  if (!tarball) return false
  const res = await fetch(tarball, { method: 'HEAD' }).catch(() => null)
  if (!res?.ok) return false
  const children = await view(`${real}@${version}`, 'dependencies', NPMJS) || {}
  for (const range of Object.values(children)) {
    const [, childReal, childVersion] = String(range).match(/^npm:(@hadoku\/[^@]+)@(.+)$/) || []
    const key = `${childReal}@${childVersion}`
    if (childReal && EXACT.test(childVersion) && !awaited.has(key)) {
      awaited.set(key, { real: childReal, version: childVersion })
      pending.add(key)
    }
  }
  return true
}

while (pending.size) {
  const round = [...pending]
  const ok = await Promise.all(round.map(k => served(awaited.get(k))))
  round.forEach((k, i) => ok[i] && pending.delete(k))
  if (!pending.size) break
  if (Date.now() + poll * 1000 >= deadline) {
    for (const k of pending) console.log(`::error::npmjs still does not serve ${k} (listed and its tarball) after ${budget}s; GitHub Packages has it. Did its publish-npmjs run fail?`)
    process.exit(1)
  }
  console.log(`::notice::waiting for npmjs to serve ${[...pending].join(', ')} (${Math.round((Date.now() - started) / 1000)}s of ${budget}s)`)
  await new Promise(r => setTimeout(r, poll * 1000))
}

specs.sort()
console.log(`Pinned for every attempt: ${specs.join(' ') || '(no @wolffm dependencies)'}`)
appendFileSync(process.env.GITHUB_OUTPUT, `specs=${specs.join(' ')}\ndeadline=${Math.floor(deadline / 1000)}\nresolved-at=${Math.floor(started / 1000)}\n`)
