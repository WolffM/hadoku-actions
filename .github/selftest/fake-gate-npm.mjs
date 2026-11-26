#!/usr/bin/env node
// Stand-in npm (and pnpm) for publish-gate: answers from $FAKE_REGISTRY's
// registry.json, { "<name>": { "versions": [...], "error": "E401",
// "tarballs": { "<version>": "<dir holding the package's files>" } } }.
//   view <name> versions --json        the versions, E404 for an unknown name
//   pack <name>@<v> ... --pack-destination D   that version's files as a .tgz
//   pack --pack-destination D          the current directory as a .tgz
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = process.env.FAKE_REGISTRY;
const registry = JSON.parse(readFileSync(join(root, 'registry.json'), 'utf8'));
const [cmd, ...args] = process.argv.slice(2);
const dest = args[args.indexOf('--pack-destination') + 1];

function tgz(src) {
	const stage = mkdtempSync(join(tmpdir(), 'fake-gate-npm-'));
	cpSync(src, join(stage, 'package'), { recursive: true });
	execFileSync('tar', ['-czf', join(dest, 'pkg.tgz'), '-C', stage, 'package']);
}

if (cmd === 'view' && args[1] === 'versions') {
	const entry = registry[args[0]];
	if (!entry) {
		process.stderr.write('npm error code E404\n');
		process.exit(1);
	}
	if (entry.error) {
		process.stderr.write(`{"error": {"code": "${entry.error}"}}\n`);
		process.exit(1);
	}
	process.stdout.write(JSON.stringify(entry.versions));
} else if (cmd === 'pack' && args[0] !== '--pack-destination' && args[0].lastIndexOf('@') > 0) {
	const at = args[0].lastIndexOf('@');
	const src = registry[args[0].slice(0, at)]?.tarballs?.[args[0].slice(at + 1)];
	if (!src) {
		process.stderr.write(`fake-gate-npm: no tarball for ${args[0]}\n`);
		process.exit(1);
	}
	tgz(resolve(root, src));
} else if (cmd === 'pack') {
	tgz(process.cwd());
} else {
	process.stderr.write(`fake-gate-npm: unexpected ${process.argv.slice(2).join(' ')}\n`);
	process.exit(2);
}
