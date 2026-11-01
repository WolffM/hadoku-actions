import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { main, nextVersion } from './next-version.mjs';

test('one patch above the registry newest, whatever package.json says', () => {
	assert.deepEqual(nextVersion('0.34.2', ['0.34.1', '0.34.302', '0.34.99']), {
		version: '0.34.303',
		newest: '0.34.302',
	});
	// Numeric, never lexical: 0.34.99 < 0.34.302.
	assert.equal(nextVersion('0.1.0', ['0.34.99', '0.34.302']).version, '0.34.303');
});

test('a committed version above the registry is published as it stands', () => {
	assert.equal(nextVersion('0.35.0', ['0.34.302']).version, '0.35.0');
	assert.equal(nextVersion('0.34.302', ['0.34.302']).version, '0.34.303');
});

test('never published: package.json as committed', () => {
	assert.deepEqual(nextVersion('1.0.0', null), { version: '1.0.0', newest: null });
});

test('prereleases and junk never seed the walk', () => {
	assert.equal(nextVersion('0.1.0', ['0.2.0', '9.0.0-beta.1', '[WARN] slow']).version, '0.2.1');
});

/** A package dir and a stand-in npm that answers from a script. */
function fixture(npmBody, version = '0.34.2') {
	const dir = mkdtempSync(join(tmpdir(), 'next-version-'));
	writeFileSync(
		join(dir, 'package.json'),
		`{\n  "name": "@wolffm/x",\n  "version": "${version}",\n  "private": false\n}\n`
	);
	const npm = join(dir, 'fake-npm');
	writeFileSync(npm, `#!/bin/sh\n${npmBody}\n`);
	chmodSync(npm, 0o755);
	const out = join(dir, 'out');
	writeFileSync(out, '');
	const env = { NEXT_VERSION_DIR: dir, NEXT_VERSION_NPM: npm, GITHUB_OUTPUT: out, GITHUB_SHA: 'c0ffee' };
	return { dir, env, out: () => readFileSync(out, 'utf8'), pkg: () => readFileSync(join(dir, 'package.json'), 'utf8') };
}

test('writes the version into package.json and nothing else', () => {
	const f = fixture(`case "$3" in versions) echo '["0.34.300","0.34.301"]';; *) echo deadbeef;; esac`);
	assert.equal(main(f.env), 0);
	assert.equal(f.pkg(), '{\n  "name": "@wolffm/x",\n  "version": "0.34.302",\n  "private": false\n}\n');
	assert.match(f.out(), /^version=0\.34\.302$/m);
	assert.match(f.out(), /^published=false$/m);
});

test('one published version comes back as a bare string, not an array', () => {
	const f = fixture(`case "$3" in versions) echo '"1.2.3"';; *) echo deadbeef;; esac`, '1.0.0');
	main(f.env);
	assert.match(f.out(), /^version=1\.2\.4$/m);
});

test('a re-run of the commit that published the newest version publishes nothing new', () => {
	const f = fixture(`case "$3" in versions) echo '["0.34.300","0.34.301"]';; *) echo c0ffee;; esac`);
	main(f.env);
	assert.match(f.out(), /^version=0\.34\.301$/m);
	assert.match(f.out(), /^published=true$/m);
});

test('a 404 is "never published"; any other registry failure refuses to guess', () => {
	const fresh = fixture(`echo '{"error":{"code":"E404"}}'; exit 1`, '0.1.0');
	main(fresh.env);
	assert.match(fresh.out(), /^version=0\.1\.0$/m);

	const down = fixture(`echo '{"error":{"code":"E401"}}'; exit 1`);
	assert.throws(() => main(down.env), /E401.*refusing to guess/);
	assert.equal(down.out(), '');
	assert.match(down.pkg(), /"version": "0\.34\.2"/, 'package.json untouched');
});
