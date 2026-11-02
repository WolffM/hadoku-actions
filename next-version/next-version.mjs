#!/usr/bin/env node
// The version to publish: one patch above the newest on the registry, written
// to package.json in the CI workspace only. Nothing commits it back; "the
// number is irrelevant, newest wins" (operator, 2026-11-01).
//
// FROM THE REGISTRY, NOT FROM package.json. hopper's publish.yml learned this
// the hard way (tenhands died at attempt 99 on 2026-08-05 walking up from a
// stale committed version), and this is that walk with the walk removed: every
// published version is read at once, so there is nothing to step through.
//
// A committed version ABOVE the registry's newest is published as it stands,
// so a deliberate minor or major bump in a commit still works.
//
// "Could not look" fails: an unreadable registry never guesses. Only a 404 (a
// package never published) starts from package.json — and if that 404 was
// really a missing permission, GitHub Packages refuses the publish of an
// existing version anyway.
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

export function cmp(a, b) {
	const x = a.match(SEMVER).slice(1).map(Number);
	const y = b.match(SEMVER).slice(1).map(Number);
	for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
	return 0;
}

export const bumpPatch = (v) => {
	const [, a, b, c] = v.match(SEMVER);
	return `${a}.${b}.${Number(c) + 1}`;
};

/**
 * @param {string} committed  package.json's version
 * @param {string[] | null} published  every version on the registry; null = never published
 * @returns {{ version: string, newest: string | null }}
 */
export function nextVersion(committed, published) {
	if (!SEMVER.test(committed)) throw new Error(`package.json version '${committed}' is not x.y.z`);
	// Prereleases and anything else non-x.y.z never seed the next release.
	const releases = (published ?? []).filter((v) => SEMVER.test(v)).sort(cmp);
	const newest = releases.at(-1) ?? null;
	if (!newest) return { version: committed, newest };
	if (cmp(committed, newest) > 0) return { version: committed, newest };
	return { version: bumpPatch(newest), newest };
}

/** `npm view <name> versions --json`: an array, a bare string for one version, or E404. */
export function readPublished(name, npm = 'npm', cwd = process.cwd()) {
	let out;
	try {
		out = execFileSync(npm, ['view', name, 'versions', '--json'], {
			cwd,
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'pipe'],
		});
	} catch (err) {
		const text = `${err.stdout ?? ''}\n${err.stderr ?? ''}`;
		if (/\bE404\b/.test(text)) return null;
		const code = text.match(/"code":\s*"(\w+)"/)?.[1] ?? `exit ${err.status}`;
		throw new Error(`could not read ${name}'s published versions (${code}); refusing to guess a version`);
	}
	const parsed = JSON.parse(out);
	return Array.isArray(parsed) ? parsed : [parsed];
}

/** The gitHead the registry recorded for one version, or '' when unreadable. */
export function readGitHead(name, version, npm = 'npm', cwd = process.cwd()) {
	try {
		return execFileSync(npm, ['view', `${name}@${version}`, 'gitHead'], {
			cwd,
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'pipe'],
		}).trim();
	} catch (err) {
		// Only used to recognise a re-run; unreadable means "not this commit",
		// and the publish of a fresh patch is the safe consequence.
		process.stdout.write(
			`::warning::could not read ${name}@${version}'s gitHead (exit ${err.status}); treating this as a new release\n`
		);
		return '';
	}
}

/** Rewrite only the version field, leaving every other byte of package.json alone. */
export function writeVersion(file, version) {
	const src = readFileSync(file, 'utf8');
	const next = src.replace(/("version"\s*:\s*")[^"]*(")/, (_, a, b) => a + version + b);
	if (next === src && !src.includes(`"version": "${version}"`))
		throw new Error(`could not patch the version in ${file}`);
	writeFileSync(file, next);
}

/**
 * Record the publishing commit as `gitHead` beside the version. npm sets it at
 * publish; `pnpm publish` does not, so without this a re-run of a pnpm repo's
 * publish never reads as one and ships the same build as a fresh patch.
 */
export function writeGitHead(file, sha) {
	const src = readFileSync(file, 'utf8');
	const next = /"gitHead"\s*:/.test(src)
		? src.replace(/("gitHead"\s*:\s*")[^"]*(")/, (_, a, b) => a + sha + b)
		: src.replace(
				/^(\s*)("version"\s*:\s*"[^"]*")(,?)$/m,
				(_, indent, field, comma) => `${indent}${field},\n${indent}"gitHead": "${sha}"${comma}`
			);
	if (next === src) throw new Error(`could not record gitHead in ${file}`);
	writeFileSync(file, next);
}

export function main(env = process.env) {
	const dir = env.NEXT_VERSION_DIR || '.';
	const npm = env.NEXT_VERSION_NPM || 'npm';
	const file = join(dir, 'package.json');
	const pkg = JSON.parse(readFileSync(file, 'utf8'));
	const out = (k, v) => env.GITHUB_OUTPUT && appendFileSync(env.GITHUB_OUTPUT, `${k}=${v}\n`);

	const published = readPublished(pkg.name, npm, dir);
	const { version, newest } = nextVersion(pkg.version, published);

	// A RE-RUN of the commit that published the newest version is not a new
	// release: the publish already happened and only a later step failed. npm
	// records the publishing commit as gitHead, so this is decided exactly.
	const sha = env.GITHUB_SHA;
	if (newest && sha && readGitHead(pkg.name, newest, npm, dir) === sha) {
		writeVersion(file, newest);
		out('version', newest);
		out('published', 'true');
		process.stdout.write(`${pkg.name}@${newest} was published by this commit (${sha}); nothing to publish\n`);
		return 0;
	}
	writeVersion(file, version);
	if (sha) writeGitHead(file, sha);
	out('version', version);
	out('published', 'false');
	process.stdout.write(
		`${pkg.name}: registry newest ${newest ?? '(never published)'}, committed ${pkg.version}; publishing ${version}\n`
	);
	return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
	try {
		process.exitCode = main();
	} catch (err) {
		process.stdout.write(`::error::${err.message}\n`);
		process.exitCode = 1;
	}
}
