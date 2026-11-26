// Every rule that lets a difference through has a case here, and so does every
// way a real change could hide behind one. The false-equal cases matter most:
// an equal verdict skips a publish.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import { canonical, compareTarballs, readTarball, stampPattern } from './compare.mjs';

const SHA_A = '38ddd15916cce904c43620666cdaf2180573f36c';
const SHA_B = 'fa5691c9d19f07c04e900110cdce8a407477bcb7';

const manifest = (version, gitHead, extra = {}) =>
	JSON.stringify({
		name: '@wolffm/demo',
		version,
		gitHead,
		main: './dist/index.js',
		dependencies: { '@wolffm/logger': '^1.4.5' },
		devDependencies: { '@wolffm/themes': '5.14.17' },
		scripts: { build: 'vite build' },
		...extra,
	});

/** Map<path, Buffer> straight from an object, as readTarball returns. */
const tree = (files) => new Map(Object.entries(files).map(([k, v]) => [`package/${k}`, Buffer.from(v)]));

const OPTS = { prevVersion: '1.9.92', nextVersion: '1.9.93', sha: SHA_B, prevGitHead: SHA_A };

const base = (version, gitHead) => ({
	'package.json': manifest(version, gitHead),
	'dist/index.js': 'export const x = 1;',
});

test('identical files with only version, gitHead and devDependencies moved are equal', () => {
	const prev = tree(base('1.9.92', SHA_A));
	const next = tree({
		...base('1.9.93', SHA_B),
		'package.json': manifest('1.9.93', SHA_B, { devDependencies: { '@wolffm/themes': '5.14.18' } }),
	});
	assert.deepEqual(compareTarballs(prev, next, OPTS), { equal: true, reason: 'equal' });
});

test('a code change is not equal', () => {
	const prev = tree(base('1.9.92', SHA_A));
	const next = tree({ ...base('1.9.93', SHA_B), 'dist/index.js': 'export const x = 2;' });
	assert.deepEqual(compareTarballs(prev, next, OPTS), { equal: false, reason: 'changed package/dist/index.js' });
});

test('a runtime dependency change is not equal', () => {
	const prev = tree(base('1.9.92', SHA_A));
	const next = tree({
		...base('1.9.93', SHA_B),
		'package.json': manifest('1.9.93', SHA_B, { dependencies: { '@wolffm/logger': '^1.4.6' } }),
	});
	assert.equal(compareTarballs(prev, next, OPTS).reason, 'manifest differs');
});

test('nested manifest fields are compared, not dropped', () => {
	// JSON.stringify with a key list filters nested keys too; that would make
	// every dependency map compare as {} and this case come out equal.
	const prev = tree(base('1.9.92', SHA_A));
	const next = tree({
		...base('1.9.93', SHA_B),
		'package.json': manifest('1.9.93', SHA_B, { exports: { '.': './dist/other.js' } }),
	});
	assert.equal(compareTarballs(prev, next, OPTS).equal, false);
	assert.equal(canonical({ b: { y: 1, x: 2 }, a: [3] }), '{"a":[3],"b":{"x":2,"y":1}}');
});

test('an added install hook is not equal; other scripts are ignored', () => {
	const prev = tree(base('1.9.92', SHA_A));
	const hook = tree({
		...base('1.9.93', SHA_B),
		'package.json': manifest('1.9.93', SHA_B, { scripts: { build: 'vite build', postinstall: 'node x.js' } }),
	});
	assert.equal(compareTarballs(prev, hook, OPTS).equal, false);
	const lint = tree({
		...base('1.9.93', SHA_B),
		'package.json': manifest('1.9.93', SHA_B, { scripts: { build: 'vite build', lint: 'eslint .' } }),
	});
	assert.equal(compareTarballs(prev, lint, OPTS).equal, true);
});

test('the own version stamped into a bundle is equal', () => {
	const prev = tree({ ...base('1.9.92', SHA_A), 'dist/index.js': 'const v="1.9.92";' });
	const next = tree({ ...base('1.9.93', SHA_B), 'dist/index.js': 'const v="1.9.93";' });
	assert.equal(compareTarballs(prev, next, OPTS).equal, true);
});

test('a bundled dependency whose version contains ours is not masked', () => {
	// 11.9.92 -> 11.9.93 and 1.9.92a: neither is the package's own version.
	const prev = tree({ ...base('1.9.92', SHA_A), 'dist/index.js': 'dep="11.9.92";' });
	const next = tree({ ...base('1.9.93', SHA_B), 'dist/index.js': 'dep="11.9.93";' });
	assert.equal(compareTarballs(prev, next, OPTS).equal, false);
	const p2 = tree({ ...base('1.9.92', SHA_A), 'dist/index.js': 'dep="1.9.92.1";' });
	const n2 = tree({ ...base('1.9.93', SHA_B), 'dist/index.js': 'dep="1.9.93.1";' });
	assert.equal(compareTarballs(p2, n2, OPTS).equal, false);
});

test('a commit SHA stamp, full or short, is equal', () => {
	const prev = tree({ ...base('1.9.92', SHA_A), 'dist/index.js': `b="${SHA_A.slice(0, 7)}";c="${SHA_A}";` });
	const next = tree({ ...base('1.9.93', SHA_B), 'dist/index.js': `b="${SHA_B.slice(0, 7)}";c="${SHA_B}";` });
	assert.equal(compareTarballs(prev, next, OPTS).equal, true);
});

test('other hex content is never treated as a stamp', () => {
	const prev = tree({ ...base('1.9.92', SHA_A), 'dist/a.css': '.x{color:#a1b2c3d4}' });
	const next = tree({ ...base('1.9.93', SHA_B), 'dist/a.css': '.x{color:#a1b2c3d5}' });
	assert.equal(compareTarballs(prev, next, OPTS).equal, false);
	// A SHA prefix inside a longer hex run is not a token.
	const p2 = tree({ ...base('1.9.92', SHA_A), 'dist/a.js': `h="${SHA_A.slice(0, 7)}ff"` });
	const n2 = tree({ ...base('1.9.93', SHA_B), 'dist/a.js': `h="${SHA_B.slice(0, 7)}ff"` });
	assert.equal(compareTarballs(p2, n2, OPTS).equal, false);
	// ...nor one preceded by more hex.
	const p3 = tree({ ...base('1.9.92', SHA_A), 'dist/a.js': `h="ff${SHA_A.slice(0, 7)}"` });
	const n3 = tree({ ...base('1.9.93', SHA_B), 'dist/a.js': `h="ff${SHA_B.slice(0, 7)}"` });
	assert.equal(compareTarballs(p3, n3, OPTS).equal, false);
});

test('a renamed content-hash chunk with identical code is equal, with its references', () => {
	const prev = tree({
		...base('1.9.92', SHA_A),
		'dist/index.js': 'import("./chunks/Room-Ep6GkVA3.js");',
		'dist/chunks/Room-Ep6GkVA3.js': 'export default 1;',
	});
	const next = tree({
		...base('1.9.93', SHA_B),
		'dist/index.js': 'import("./chunks/Room-Zz9GkVA4.js");',
		'dist/chunks/Room-Zz9GkVA4.js': 'export default 1;',
	});
	assert.equal(compareTarballs(prev, next, OPTS).equal, true);
});

test('a renamed chunk whose code changed is not equal', () => {
	const prev = tree({ ...base('1.9.92', SHA_A), 'dist/chunks/Room-Ep6GkVA3.js': 'export default 1;' });
	const next = tree({ ...base('1.9.93', SHA_B), 'dist/chunks/Room-Zz9GkVA4.js': 'export default 2;' });
	assert.equal(compareTarballs(prev, next, OPTS).equal, false);
});

test('two chunks that normalise to one name fail toward publishing', () => {
	const files = { 'dist/a-AAAAAAAA.js': '1', 'dist/a-BBBBBBBB.js': '2' };
	const prev = tree({ ...base('1.9.92', SHA_A), ...files });
	const next = tree({ ...base('1.9.93', SHA_B), ...files });
	assert.deepEqual(compareTarballs(prev, next, OPTS), {
		equal: false,
		reason: 'newest: two files normalise to package/dist/a-HASH.js',
	});
});

test('an added or removed file is not equal', () => {
	const prev = tree(base('1.9.92', SHA_A));
	const next = tree({ ...base('1.9.93', SHA_B), 'dist/extra.js': '' });
	assert.equal(compareTarballs(prev, next, OPTS).reason, 'added package/dist/extra.js');
	assert.equal(compareTarballs(next, prev, OPTS).reason, 'removed package/dist/extra.js');
});

test('.map files are ignored', () => {
	const prev = tree({ ...base('1.9.92', SHA_A), 'dist/index.js.map': '{"sources":["a@1"]}' });
	const next = tree({ ...base('1.9.93', SHA_B), 'dist/index.js.map': '{"sources":["a@2"]}' });
	assert.equal(compareTarballs(prev, next, OPTS).equal, true);
});

test('binary files compare as bytes', () => {
	const prev = new Map([...tree(base('1.9.92', SHA_A)), ['package/a.png', Buffer.from([0, 1, 2])]]);
	const next = new Map([...tree(base('1.9.93', SHA_B)), ['package/a.png', Buffer.from([0, 1, 3])]]);
	assert.equal(compareTarballs(prev, next, OPTS).equal, false);
});

test('a sibling pinned at the group version is equal; any other pin is not', () => {
	const opts = { ...OPTS, siblings: ['@wolffm/rooms-protocol'] };
	const pin = (v, spec) =>
		manifest(v, v === '1.9.92' ? SHA_A : SHA_B, { dependencies: { '@wolffm/rooms-protocol': spec } });
	const prev = tree({ ...base('1.9.92', SHA_A), 'package.json': pin('1.9.92', '1.9.92') });
	const next = tree({ ...base('1.9.93', SHA_B), 'package.json': pin('1.9.93', '1.9.93') });
	assert.equal(compareTarballs(prev, next, opts).equal, true);
	const alias = (v) => `npm:@hadoku/rooms-protocol@${v}`;
	const pa = tree({ ...base('1.9.92', SHA_A), 'package.json': pin('1.9.92', alias('1.9.92')) });
	const na = tree({ ...base('1.9.93', SHA_B), 'package.json': pin('1.9.93', alias('1.9.93')) });
	assert.equal(compareTarballs(pa, na, opts).equal, true);
	// Not a sibling: the same move is a real dependency change.
	assert.equal(compareTarballs(prev, next, OPTS).equal, false);
	// A sibling moved to some other version is a real change.
	const odd = tree({ ...base('1.9.93', SHA_B), 'package.json': pin('1.9.93', '1.9.90') });
	assert.equal(compareTarballs(prev, odd, opts).equal, false);
});

test('a tarball without package/package.json is not equal', () => {
	const prev = new Map([['other/package.json', Buffer.from('{}')]]);
	assert.equal(compareTarballs(prev, prev, OPTS).equal, false);
});

test('stampPattern anchors versions on digit and dot boundaries', () => {
	const re = stampPattern({ versions: ['1.2.3'], shas: [] });
	assert.equal('v1.2.3 x1.2.3- 11.2.3 1.2.34 1.2.3.4 1.2.3'.replace(re, 'S'), 'vS xS- 11.2.3 1.2.34 1.2.3.4 S');
});

test('readTarball reads a real .tgz', () => {
	const dir = mkdtempSync(join(tmpdir(), 'pg-test-'));
	try {
		const src = join(dir, 'package');
		for (const [p, c] of Object.entries(base('1.9.92', SHA_A))) {
			mkdirSync(dirname(join(src, p)), { recursive: true });
			writeFileSync(join(src, p), c);
		}
		execFileSync('tar', ['-czf', join(dir, 'a.tgz'), '-C', dir, 'package']);
		const files = readTarball(join(dir, 'a.tgz'));
		assert.deepEqual([...files.keys()].sort(), ['package/dist/index.js', 'package/package.json']);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("each manifest's own gitHead counts as a SHA stamp without being passed", () => {
	const prev = tree({ ...base('1.9.92', SHA_A), 'dist/index.js': `c="${SHA_A}";` });
	const next = tree({ ...base('1.9.93', SHA_B), 'dist/index.js': `c="${SHA_B}";` });
	assert.equal(compareTarballs(prev, next, { prevVersion: '1.9.92', nextVersion: '1.9.93' }).equal, true);
	// A gitHead that is not a full SHA is never a stamp.
	const p2 = tree({ 'package.json': manifest('1.9.92', 'abc1234'), 'dist/index.js': 'c="abc1234";' });
	const n2 = tree({ 'package.json': manifest('1.9.93', 'def5678'), 'dist/index.js': 'c="def5678";' });
	assert.equal(compareTarballs(p2, n2, { prevVersion: '1.9.92', nextVersion: '1.9.93' }).equal, false);
});
