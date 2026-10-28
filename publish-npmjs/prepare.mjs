#!/usr/bin/env node
// Turn a packed @wolffm/* tarball into the @hadoku/* package npmjs gets.
//
//   node prepare.mjs <tarball.tgz> <out-dir>
//
// Leaves the publishable package in <out-dir>/package and prints its file
// list. Exits 1, naming every problem, when the package is not on the public
// list, depends on a @wolffm/* package that is not, or contains anything the
// leak gate refuses. Node builtins and `tar` only: the claws have no unzip, and
// this runs before anything is installed.
//
// WHY A REWRITE AND NOT A SECOND NAME IN THE SOURCE REPOS
// --------------------------------------------------------
// About twenty repos import these packages as @wolffm/*. Republishing under a
// rewritten name leaves every one of them untouched; a public consumer maps the
// @wolffm/* names it imports onto @hadoku/* with npm aliases instead.
//
//   dependencies / optionalDependencies  @wolffm/y  -> "npm:@hadoku/y@<spec>"
//       so an outsider's install never asks GitHub Packages for anything.
//   peerDependencies                     unchanged
//       a peer is satisfied by whatever the consumer installed under that
//       name, and the consumer's alias installs @hadoku/y AS @wolffm/y.
//   devDependencies, publishConfig       dropped (a consumer needs neither)
//   scripts                              only install-time hooks are kept, so
//       `npm publish` of the unpacked copy cannot re-run a build here.

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const [tarball, outDir] = process.argv.slice(2);
if (!tarball || !outDir) {
  console.error('usage: prepare.mjs <tarball.tgz> <out-dir>');
  process.exit(2);
}

const here = dirname(fileURLToPath(import.meta.url));
const PUBLIC = new Set(JSON.parse(readFileSync(join(here, 'public-packages.json'), 'utf8')).packages);
const FROM = '@wolffm/';
const TO = '@hadoku/';

mkdirSync(outDir, { recursive: true });
// -m: npm stamps every entry 1985-10-26, and an age-based /tmp cleaner deletes
// files that old mid-run (it did, during this script's first audit).
execFileSync('tar', ['-xzmf', tarball, '-C', outDir]);
const pkgDir = join(outDir, 'package');
const pkgPath = join(pkgDir, 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));

const problems = [];

// ── Names ───────────────────────────────────────────────────────────────────
const shortName = (name) => (name.startsWith(FROM) ? name.slice(FROM.length) : null);

const own = shortName(pkg.name ?? '');
if (!own) problems.push(`package name ${pkg.name} is not ${FROM}*`);
else if (!PUBLIC.has(own)) problems.push(`${pkg.name} is not in public-packages.json`);
const fromName = pkg.name;
if (own) pkg.name = TO + own;

for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
  for (const [dep, spec] of Object.entries(pkg[field] ?? {})) {
    const short = shortName(dep);
    if (!short) continue;
    if (!PUBLIC.has(short)) {
      problems.push(`${field}: ${dep} is not public, so ${pkg.name} would 401 for anyone outside the fleet`);
      continue;
    }
    if (field === 'peerDependencies') continue;
    if (/^(workspace|npm|file|link):/.test(spec)) {
      problems.push(`${field}: ${dep} has spec "${spec}", which pnpm pack should have resolved to a version`);
      continue;
    }
    pkg[field][dep] = `npm:${TO}${short}@${spec}`;
  }
}
if (pkg.bundleDependencies || pkg.bundledDependencies) {
  problems.push('bundled dependencies are not supported: the gate would have to vet them too');
}

delete pkg.devDependencies;
delete pkg.publishConfig;
if (pkg.scripts) {
  const kept = Object.fromEntries(
    Object.entries(pkg.scripts).filter(([k]) => ['preinstall', 'install', 'postinstall'].includes(k)),
  );
  if (Object.keys(kept).length) pkg.scripts = kept;
  else delete pkg.scripts;
}

// ── Leak gate ───────────────────────────────────────────────────────────────
// Each pattern is a thing the 2026-10-27 audit of the first nine packages
// looked for by hand. A hit names the file, line and pattern but never prints
// the match: if it is a real credential, the log is public.
const PATTERNS = [
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/],
  ['npm token', /\bnpm_[A-Za-z0-9]{36}\b/],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ['API secret key', /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}/],
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['JWT', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ['Discord webhook', /discord(?:app)?\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+/],
  ['home directory path', /\/home\/[a-z][a-z0-9_-]*\/|\/Users\/[A-Za-z][^/\s"'`]*\/|[A-Z]:\\{1,2}Users\\{1,2}/],
  ['fleet host name', /\bhokon\b|\bclaw-?\d+\b|\.ts\.net\b/i],
  [
    'private IPv4 address',
    /\b(?:10\.\d{1,3}|192\.168|172\.(?:1[6-9]|2\d|3[01])|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7]))\.\d{1,3}\.\d{1,3}\b/,
  ],
];
const FORBIDDEN_FILES = [
  ['env file', /(^|\/)\.env(\..*)?$/],
  ['npmrc', /(^|\/)\.npmrc$/],
  ['vault config', /(^|\/)\.devvault(\..*)?\.json$/],
  ['key material', /\.(pem|key|p12|pfx)$|(^|\/)id_(rsa|ed25519|ecdsa)/],
];

const files = [];
const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else files.push(full);
  }
};
walk(pkgDir);

for (const full of files) {
  const rel = relative(pkgDir, full);
  for (const [what, re] of FORBIDDEN_FILES) if (re.test(rel)) problems.push(`${rel}: ${what} must never ship`);
  const buf = readFileSync(full);
  if (buf.subarray(0, 8192).includes(0)) continue;
  const lines = buf.toString('utf8').split('\n');
  for (const [what, re] of PATTERNS) {
    const at = lines.findIndex((l) => re.test(l));
    if (at !== -1) problems.push(`${rel}:${at + 1}: ${what}`);
  }
}

if (problems.length) {
  console.error(`refusing to publish ${fromName} to npmjs:`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

console.log(`${fromName} -> ${pkg.name}@${pkg.version}, ${files.length} files:`);
for (const full of files.sort()) {
  console.log(`  ${String(statSync(full).size).padStart(9)}  ${relative(pkgDir, full)}`);
}
for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
  const deps = Object.entries(pkg[field] ?? {}).filter(([d]) => d.startsWith(FROM));
  for (const [d, s] of deps) console.log(`  ${field}: ${d} = ${s}`);
}

if (process.env.GITHUB_OUTPUT) {
  writeFileSync(process.env.GITHUB_OUTPUT, `name=${pkg.name}\nversion=${pkg.version}\n`, { flag: 'a' });
}
