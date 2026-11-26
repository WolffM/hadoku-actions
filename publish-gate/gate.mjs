#!/usr/bin/env node
// Should this run publish? Skips a publish whose tarball is equivalent to the
// registry's newest (compare.mjs says what "equivalent" allows), and ships in
// every other case. The plan, its review and the measurement behind it are
// hadoku_site docs/planning/publish-gate-2026-11-25.md.
//
// Runs after next-version and the build, on one package or on one LOCKSTEP
// GROUP (every package-dir listed shares one version and skips together).
//
// SHIPS UNLESS PROVEN EQUAL. A skip needs, for every member:
//   - the registry's newest read, and this run's version exactly one patch
//     above it (a committed minor/major bump, a re-run, a first publish ship);
//   - both tarballs packed and compareTarballs equal;
//   - an npmjs mirror (publish-npmjs/public-packages.json) that already serves
//     the newest, so a lagging mirror is healed by the publish, not frozen;
// and the run is not a workflow_dispatch, the operator's "publish now".
// Anything unreadable, unexpected or thrown ships. This step never fails a
// publish, except on a mode it does not know (a typo must not read as report).
//
// report (the default): always `ships=true`; the would-be verdict is a notice
// and a step-summary row. enforce: on a skip, every member's package.json is
// set back to the newest version, so the workspace never names a version that
// does not exist and the steps after the publish act on the newest.
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { bumpPatch, cmp, readPublished, writeVersion } from '../next-version/next-version.mjs';
import { compareTarballs, readTarball } from './compare.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const SEMVER = /^\d+\.\d+\.\d+$/;
const MODES = new Set(['report', 'enforce']);

const PUBLIC = new Set(
	JSON.parse(readFileSync(join(here, '..', 'publish-npmjs', 'public-packages.json'), 'utf8')).packages
);

/** The @hadoku/* name a @wolffm/* package is mirrored to on npmjs, or null. */
export function mirrorName(name) {
	const m = name.match(/^@wolffm\/(.+)$/);
	return m && PUBLIC.has(m[1]) ? `@hadoku/${m[1]}` : null;
}

/** Does npmjs serve name@version? true, false (404), or throws. */
export async function npmjsServes(name, version, fetchImpl = fetch, base = 'https://registry.npmjs.org') {
	const res = await fetchImpl(`${base}/${name.replace('/', '%2f')}/${version}`, {
		headers: { accept: 'application/json' },
	});
	if (res.status === 404) return false;
	if (!res.ok) throw new Error(`npmjs answered ${res.status} for ${name}@${version}`);
	return true;
}

/** Pack into a fresh dir and return the one .tgz it produced. */
function pack(cmd, args, cwd) {
	const dest = mkdtempSync(join(tmpdir(), 'publish-gate-pack-'));
	execFileSync(cmd, [...args, '--pack-destination', dest], { cwd, stdio: ['ignore', 'ignore', 'pipe'] });
	const tgz = readdirSync(dest).filter((f) => f.endsWith('.tgz'));
	if (tgz.length !== 1) throw new Error(`${cmd} pack left ${tgz.length} tarballs`);
	return { path: join(dest, tgz[0]), dest };
}

/** One member's verdict: { name, version, newest, equal, reason }. */
export async function judgeMember(dir, siblings, io) {
	const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
	const m = { dir, name: pkg.name, version: pkg.version, newest: null, equal: false, reason: '' };
	const published = readPublished(pkg.name, io.npm, dir);
	if (!published) return { ...m, reason: 'never published' };
	const newest = published.filter((v) => SEMVER.test(v)).sort(cmp).at(-1);
	m.newest = newest ?? null;
	if (!newest) return { ...m, reason: 'no release on the registry' };
	if (pkg.version === newest) return { ...m, reason: `re-run: ${newest} is already published` };
	if (!SEMVER.test(pkg.version) || pkg.version !== bumpPatch(newest)) {
		return { ...m, reason: `version ${pkg.version} is not one patch above ${newest}` };
	}
	const mirror = mirrorName(pkg.name);
	if (mirror && !(await io.npmjsServes(mirror, newest))) {
		return { ...m, reason: `npmjs does not serve ${mirror}@${newest} yet` };
	}
	const dirs = [];
	try {
		const prev = pack(io.npm, ['pack', `${pkg.name}@${newest}`, '--ignore-scripts'], dir);
		dirs.push(prev.dest);
		const next = pack(io.packer, ['pack'], dir);
		dirs.push(next.dest);
		const verdict = compareTarballs(readTarball(prev.path), readTarball(next.path), {
			prevVersion: newest,
			nextVersion: pkg.version,
			sha: io.sha,
			siblings,
		});
		return { ...m, ...verdict };
	} finally {
		for (const d of dirs) rmSync(d, { recursive: true, force: true });
	}
}

/**
 * @returns {Promise<{ verdict: 'skip'|'ship', reason: string, members: object[] }>}
 */
export async function judge({ dirs, event, io }) {
	if (event === 'workflow_dispatch') {
		return { verdict: 'ship', reason: 'workflow_dispatch always ships', members: [] };
	}
	const names = dirs.map((d) => JSON.parse(readFileSync(join(d, 'package.json'), 'utf8')).name);
	const members = [];
	for (const dir of dirs) {
		try {
			members.push(await judgeMember(dir, names, io));
		} catch (e) {
			members.push({ dir, equal: false, reason: `error: ${e.message}` });
		}
	}
	const odd = members.find((m) => !m.equal);
	if (odd) {
		const who = members.length > 1 ? `${odd.name ?? odd.dir}: ` : '';
		return { verdict: 'ship', reason: `${who}${odd.reason}`, members };
	}
	const versions = new Set(members.map((m) => m.version));
	if (versions.size !== 1) {
		return { verdict: 'ship', reason: `lockstep group at ${[...versions].join(', ')}`, members };
	}
	return { verdict: 'skip', reason: 'equal to the newest', members };
}

export async function main(env = process.env, deps = {}) {
	const mode = env.PUBLISH_GATE_MODE || 'report';
	if (!MODES.has(mode)) throw new Error(`mode '${mode}' is neither report nor enforce`);
	const dirs = (env.PUBLISH_GATE_DIRS || '.')
		.split('\n')
		.map((s) => s.trim())
		.filter(Boolean);
	const io = {
		npm: env.PUBLISH_GATE_NPM || 'npm',
		packer: env.PUBLISH_GATE_PACKER || 'pnpm',
		sha: env.PUBLISH_GATE_SHA || env.GITHUB_SHA,
		npmjsServes: deps.npmjsServes ?? ((n, v) => npmjsServes(n, v)),
	};
	const out = (k, v) => env.GITHUB_OUTPUT && appendFileSync(env.GITHUB_OUTPUT, `${k}=${v}\n`);
	const log = deps.log ?? ((s) => process.stdout.write(`${s}\n`));

	let result;
	try {
		result = await judge({ dirs, event: env.GITHUB_EVENT_NAME, io });
	} catch (e) {
		result = { verdict: 'ship', reason: `error: ${e.message}`, members: [] };
	}
	const skip = mode === 'enforce' && result.verdict === 'skip';
	if (skip) for (const m of result.members) writeVersion(join(m.dir, 'package.json'), m.newest);

	const version = skip ? result.members[0].newest : (result.members[0]?.version ?? '');
	out('ships', skip ? 'false' : 'true');
	out('verdict', result.verdict);
	out('version', version);
	out('reason', result.reason.replace(/\s+/g, ' '));

	// One line per run, fixed prefix, so the shadow period can collect every
	// verdict from the check-run annotations without reading logs.
	const record = {
		mode,
		verdict: result.verdict,
		reason: result.reason,
		members: result.members.map(({ name, version: v, newest, reason }) => ({ name, version: v, newest, reason })),
	};
	log(`::notice title=publish-gate ${mode}::${JSON.stringify(record)}`);
	if (env.GITHUB_STEP_SUMMARY) {
		const rows = result.members.map((m) => `| ${m.name ?? m.dir} | ${m.newest ?? ''} | ${m.version ?? ''} | ${m.reason} |`);
		const head = skip
			? `**publish-gate: skipped**, ${result.reason}; the workspace is back at ${version}.`
			: `**publish-gate (${mode}): would ${result.verdict}**, ${result.reason}.`;
		appendFileSync(
			env.GITHUB_STEP_SUMMARY,
			[head, '', '| package | newest | this run | verdict |', '| --- | --- | --- | --- |', ...rows, ''].join('\n')
		);
	}
	return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
	main().then(
		(code) => (process.exitCode = code),
		(err) => {
			process.stdout.write(`::error::${err.message}\n`);
			process.exitCode = 1;
		}
	);
}
