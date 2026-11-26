#!/usr/bin/env node
// Is the tarball about to be published equivalent to the registry's newest?
//
// A bot dependency bump republishes a package whose shipped files did not
// change: 280 of 641 fleet publishes in the week to 2026-11-25 were bot bumps,
// and each one sets off hadoku_site's update, a deploy and a fan-out. This
// compares the two tarballs under a NARROW normalisation and answers equal or
// not, with the first difference as the reason. The plan and its review are
// hadoku_site docs/planning/publish-gate-2026-11-25.md.
//
// EQUAL MUST BE A POSITIVE PROOF. Anything this cannot read or does not
// recognise is "not equal": an unsure gate costs a spare publish, never a
// missed one.
//
// What is allowed to differ, and nothing else:
//   - package.json `version`, `gitHead`, `devDependencies`, and `scripts`
//     other than the install hooks (they never reach a consumer);
//   - an exact pin on a SIBLING package at the group's own version (lockstep
//     groups pin each other at the version they publish together);
//   - the package's own version string and the commit SHA (full, or a 7+ char
//     prefix) stamped into a text file, matched on token boundaries only;
//   - a bundler content hash in a file name (`-XXXXXXXX.js`), and references
//     to that name inside other files;
//   - `.map` files, which execute nothing (their `sources` carry pnpm store
//     paths with dependency versions in them).
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

const INSTALL_HOOKS = new Set(['preinstall', 'install', 'postinstall', 'prepare']);
const DEP_FIELDS = ['dependencies', 'peerDependencies', 'optionalDependencies'];
const HASHED = /-[A-Za-z0-9_-]{8}(\.(?:js|mjs|cjs|css))$/;

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Files of a .tgz as Map<path, Buffer>, via the system tar (no deps). */
export function readTarball(path) {
	const dir = mkdtempSync(join(tmpdir(), 'publish-gate-'));
	try {
		execFileSync('tar', ['-xzf', path, '-C', dir], { stdio: ['ignore', 'ignore', 'pipe'] });
		const files = new Map();
		const walk = (d) => {
			for (const name of readdirSync(d)) {
				const p = join(d, name);
				const st = statSync(p);
				if (st.isDirectory()) walk(p);
				else if (st.isFile()) files.set(relative(dir, p), readFileSync(p));
			}
		};
		walk(dir);
		return files;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/** Text, or null for a file that is not clean UTF-8 (compared as bytes). */
function asText(buf) {
	if (buf.includes(0)) return null;
	const s = buf.toString('utf8');
	return Buffer.from(s, 'utf8').equals(buf) ? s : null;
}

/** Replace each stamp with a placeholder, on token boundaries only. */
export function stampPattern({ versions, shas }) {
	const parts = [];
	for (const v of versions.filter(Boolean)) parts.push(`(?<![0-9.])${escape(v)}(?![0-9])(?!\\.[0-9])`);
	for (const sha of shas.filter(Boolean)) {
		// The full SHA and every prefix of 7+ chars, longest first, each one a
		// whole hex token so a prefix never matches inside a longer hex run.
		for (let n = sha.length; n >= 7; n--) parts.push(`(?<![0-9a-f])${sha.slice(0, n)}(?![0-9a-f])`);
	}
	return parts.length ? new RegExp(parts.join('|'), 'g') : null;
}

/** The manifest fields a consumer sees, with sibling pins normalised. */
export function manifestView(json, { siblings, versions }) {
	const m = JSON.parse(json);
	delete m.version;
	delete m.gitHead;
	delete m.devDependencies;
	if (m.scripts) {
		m.scripts = Object.fromEntries(Object.entries(m.scripts).filter(([k]) => INSTALL_HOOKS.has(k)));
		if (!Object.keys(m.scripts).length) delete m.scripts;
	}
	for (const field of DEP_FIELDS) {
		for (const [name, spec] of Object.entries(m[field] ?? {})) {
			if (!siblings.includes(name)) continue;
			// `0.45.138` or `npm:@scope/name@0.45.138`, exactly the group version.
			const at = spec.lastIndexOf('@');
			const v = spec.startsWith('npm:') ? spec.slice(at + 1) : spec;
			if (versions.includes(v)) m[field][name] = spec.startsWith('npm:') ? `${spec.slice(0, at + 1)}VERSION` : 'VERSION';
		}
	}
	return canonical(m);
}

/** JSON with every object's keys sorted, at every depth. */
export function canonical(v) {
	if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
	if (v && typeof v === 'object') {
		return `{${Object.keys(v)
			.sort()
			.map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`)
			.join(',')}}`;
	}
	return JSON.stringify(v);
}

/**
 * One tree, normalised: Map<normalised path, normalised content>, or a reason
 * string when it cannot be normalised unambiguously.
 */
function normaliseTree(files, ctx) {
	const pattern = stampPattern(ctx);
	const stamp = (s) => (pattern ? s.replace(pattern, 'STAMP') : s);
	const rename = new Map();
	for (const path of files.keys()) {
		if (path.endsWith('.map')) continue;
		const m = path.match(HASHED);
		if (m) rename.set(path, path.replace(HASHED, `-HASH${m[1]}`));
	}
	const out = new Map();
	for (const [path, buf] of files) {
		if (path.endsWith('.map')) continue;
		const name = rename.get(path) ?? path;
		if (out.has(name)) return { reason: `two files normalise to ${name}` };
		if (path === 'package/package.json') {
			out.set(name, manifestView(buf.toString('utf8'), ctx));
			continue;
		}
		let text = asText(buf);
		if (text === null) {
			out.set(name, buf);
			continue;
		}
		for (const [from, to] of rename) {
			const base = from.split('/').pop();
			text = text.split(base).join(to.split('/').pop());
		}
		out.set(name, stamp(text));
	}
	return { tree: out };
}

/**
 * @param {Map<string, Buffer>} prev  the registry's newest tarball
 * @param {Map<string, Buffer>} next  the tarball about to be published
 * @param {{ prevVersion: string, nextVersion: string, sha?: string,
 *           prevGitHead?: string, siblings?: string[] }} opts
 * @returns {{ equal: boolean, reason: string }}
 */
export function compareTarballs(prev, next, opts) {
	const ctx = {
		versions: [opts.prevVersion, opts.nextVersion],
		shas: [opts.sha, opts.prevGitHead],
		siblings: opts.siblings ?? [],
	};
	if (!prev.has('package/package.json') || !next.has('package/package.json')) {
		return { equal: false, reason: 'a tarball has no package/package.json' };
	}
	const a = normaliseTree(prev, ctx);
	if (a.reason) return { equal: false, reason: `newest: ${a.reason}` };
	const b = normaliseTree(next, ctx);
	if (b.reason) return { equal: false, reason: `candidate: ${b.reason}` };
	for (const name of [...new Set([...a.tree.keys(), ...b.tree.keys()])].sort()) {
		if (!a.tree.has(name)) return { equal: false, reason: `added ${name}` };
		if (!b.tree.has(name)) return { equal: false, reason: `removed ${name}` };
		const x = a.tree.get(name);
		const y = b.tree.get(name);
		const same = Buffer.isBuffer(x) && Buffer.isBuffer(y) ? x.equals(y) : x === y;
		if (!same) return { equal: false, reason: name === 'package/package.json' ? 'manifest differs' : `changed ${name}` };
	}
	return { equal: true, reason: 'equal' };
}

// CLI: node compare.mjs <prev.tgz> <next.tgz> --prev-version V --next-version V
//        [--sha S] [--prev-githead S] [--siblings a,b]
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
	const [prevPath, nextPath, ...rest] = process.argv.slice(2);
	const arg = (flag) => {
		const i = rest.indexOf(flag);
		return i === -1 ? undefined : rest[i + 1];
	};
	try {
		const verdict = compareTarballs(readTarball(prevPath), readTarball(nextPath), {
			prevVersion: arg('--prev-version'),
			nextVersion: arg('--next-version'),
			sha: arg('--sha'),
			prevGitHead: arg('--prev-githead'),
			siblings: (arg('--siblings') ?? '').split(',').filter(Boolean),
		});
		console.log(JSON.stringify(verdict));
	} catch (e) {
		console.log(JSON.stringify({ equal: false, reason: `error: ${e.message}` }));
	}
}
