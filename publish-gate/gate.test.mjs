// The gate end to end through main(), against a stand-in npm that serves
// tarballs from fixture dirs. Every way to ship has a case, and so does the
// one way to skip: a wrong skip is the failure that matters.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { main, mirrorName } from './gate.mjs';

const FAKE = join(dirname(fileURLToPath(import.meta.url)), '..', '.github', 'selftest', 'fake-gate-npm.mjs');
const SHA_A = '38ddd15916cce904c43620666cdaf2180573f36c';
const SHA_B = 'fa5691c9d19f07c04e900110cdce8a407477bcb7';

function write(dir, files) {
	for (const [p, c] of Object.entries(files)) {
		mkdirSync(dirname(join(dir, p)), { recursive: true });
		writeFileSync(join(dir, p), typeof c === 'string' ? c : JSON.stringify(c, null, 2));
	}
}

const manifest = (name, version, gitHead, deps = {}) => ({ name, version, gitHead, dependencies: deps });

/**
 * A registry holding `published` of each package, the newest one's files from
 * `prev`, and a workspace dir per package holding `next`.
 * packages: { name: { versions, prev: files, next: files, error? } }
 */
function fixture(packages) {
	const root = mkdtempSync(join(tmpdir(), 'publish-gate-test-'));
	const registry = {};
	const dirs = [];
	for (const [i, [name, p]] of Object.entries(Object.entries(packages))) {
		const entry = { versions: p.versions ?? [], tarballs: {} };
		if (p.error) entry.error = p.error;
		if (p.prev) {
			write(join(root, `prev${i}`), p.prev);
			entry.tarballs[entry.versions.at(-1)] = `prev${i}`;
		}
		if (!p.unpublished) registry[name] = entry;
		const dir = join(root, `ws${i}`);
		write(dir, p.next);
		dirs.push(dir);
	}
	writeFileSync(join(root, 'registry.json'), JSON.stringify(registry));
	const outFile = join(root, 'out');
	const summary = join(root, 'summary');
	writeFileSync(outFile, '');
	writeFileSync(summary, '');
	const env = {
		PUBLISH_GATE_NPM: FAKE,
		PUBLISH_GATE_PACKER: FAKE,
		PUBLISH_GATE_DIRS: dirs.join('\n'),
		PUBLISH_GATE_SHA: SHA_B,
		GITHUB_OUTPUT: outFile,
		GITHUB_STEP_SUMMARY: summary,
		GITHUB_EVENT_NAME: 'push',
	};
	const lines = [];
	const run = async (extra = {}, deps = {}) => {
		// The stand-in npm is a child process: it reads the real environment.
		process.env.FAKE_REGISTRY = root;
		await main({ ...env, ...extra }, { log: (s) => lines.push(s), npmjsServes: async () => true, ...deps });
		const out = Object.fromEntries(
			readFileSync(outFile, 'utf8')
				.trim()
				.split('\n')
				.map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)])
		);
		const record = JSON.parse(lines.at(-1).replace(/^::notice title=publish-gate \w+::/, ''));
		return { out, record };
	};
	const version = (i = 0) => JSON.parse(readFileSync(join(dirs[i], 'package.json'), 'utf8')).version;
	return { run, version };
}

const demo = (opts = {}) => ({
	'@wolffm/demo': {
		versions: ['1.0.0', '1.0.1'],
		prev: { 'package.json': manifest('@wolffm/demo', '1.0.1', SHA_A), 'dist/a.js': 'x=1;' },
		next: { 'package.json': manifest('@wolffm/demo', '1.0.2', SHA_B), 'dist/a.js': 'x=1;' },
		...opts,
	},
});

test('an equal tarball: report would skip and still ships', async () => {
	const f = fixture(demo());
	const { out, record } = await f.run();
	assert.deepEqual(out, { ships: 'true', verdict: 'skip', version: '1.0.2', reason: 'equal to the newest' });
	assert.equal(record.reason, 'equal to the newest');
	assert.equal(f.version(), '1.0.2', 'report mode never touches package.json');
});

test('an equal tarball: enforce skips and sets the workspace back to the newest', async () => {
	const f = fixture(demo());
	const { out } = await f.run({ PUBLISH_GATE_MODE: 'enforce' });
	assert.deepEqual(out, { ships: 'false', verdict: 'skip', version: '1.0.1', reason: 'equal to the newest' });
	assert.equal(f.version(), '1.0.1');
});

test('a code change ships', async () => {
	const f = fixture(
		demo({ next: { 'package.json': manifest('@wolffm/demo', '1.0.2', SHA_B), 'dist/a.js': 'x=2;' } })
	);
	const { out, record } = await f.run({ PUBLISH_GATE_MODE: 'enforce' });
	assert.deepEqual(out, { ships: 'true', verdict: 'ship', version: '1.0.2', reason: 'changed package/dist/a.js' });
	assert.equal(record.reason, 'changed package/dist/a.js');
	assert.equal(f.version(), '1.0.2');
});

test('workflow_dispatch ships without looking', async () => {
	const f = fixture(demo());
	const { out, record } = await f.run({ PUBLISH_GATE_MODE: 'enforce', GITHUB_EVENT_NAME: 'workflow_dispatch' });
	assert.equal(out.ships, 'true');
	assert.equal(record.reason, 'workflow_dispatch always ships');
	// The action passes the event as an input, which wins over the runner's.
	const viaInput = await f.run({ PUBLISH_GATE_MODE: 'enforce', PUBLISH_GATE_EVENT: 'workflow_dispatch' });
	assert.equal(viaInput.out.ships, 'true');
	const pinned = await f.run({ PUBLISH_GATE_EVENT: 'push', GITHUB_EVENT_NAME: 'workflow_dispatch' });
	assert.equal(pinned.out.verdict, 'skip');
});

test('a never-published package ships', async () => {
	const f = fixture(demo({ unpublished: true }));
	const { out, record } = await f.run({ PUBLISH_GATE_MODE: 'enforce' });
	assert.equal(out.ships, 'true');
	assert.equal(record.reason, 'never published');
});

test('an unreadable registry ships', async () => {
	const f = fixture(demo({ error: 'E401' }));
	const { out, record } = await f.run({ PUBLISH_GATE_MODE: 'enforce' });
	assert.equal(out.ships, 'true');
	assert.match(record.reason, /^error: could not read @wolffm\/demo's published versions \(E401\)/);
});

test('a newest tarball that cannot be fetched ships', async () => {
	const f = fixture(demo({ prev: undefined }));
	const { out, record } = await f.run({ PUBLISH_GATE_MODE: 'enforce' });
	assert.equal(out.ships, 'true');
	assert.match(record.reason, /^error: Command failed/);
	assert.match(out.reason, /^error: Command failed[^\n]*$/, 'the output is one line');
});

test('a committed minor bump ships', async () => {
	const f = fixture(
		demo({ next: { 'package.json': manifest('@wolffm/demo', '1.1.0', SHA_B), 'dist/a.js': 'x=1;' } })
	);
	const { out, record } = await f.run({ PUBLISH_GATE_MODE: 'enforce' });
	assert.equal(out.ships, 'true');
	assert.equal(record.reason, 'version 1.1.0 is not one patch above 1.0.1');
});

test('a re-run of the publishing commit ships (its publish step skips itself)', async () => {
	const f = fixture(
		demo({ next: { 'package.json': manifest('@wolffm/demo', '1.0.1', SHA_A), 'dist/a.js': 'x=1;' } })
	);
	const { out, record } = await f.run({ PUBLISH_GATE_MODE: 'enforce' });
	assert.equal(out.ships, 'true');
	assert.equal(record.reason, 're-run: 1.0.1 is already published');
});

test('a mirrored package ships while npmjs lacks the newest, and an npmjs error ships', async () => {
	const pkg = (name) => ({
		[name]: {
			versions: ['1.0.1'],
			prev: { 'package.json': manifest(name, '1.0.1', SHA_A) },
			next: { 'package.json': manifest(name, '1.0.2', SHA_B) },
		},
	});
	const f = fixture(pkg('@wolffm/logger'));
	const lag = await f.run({ PUBLISH_GATE_MODE: 'enforce' }, { npmjsServes: async () => false });
	assert.equal(lag.out.ships, 'true');
	assert.equal(lag.record.reason, 'npmjs does not serve @hadoku/logger@1.0.1 yet');
	const err = await f.run(
		{ PUBLISH_GATE_MODE: 'enforce' },
		{
			npmjsServes: async () => {
				throw new Error('npmjs answered 503');
			},
		}
	);
	assert.equal(err.out.ships, 'true');
	const ok = await f.run({ PUBLISH_GATE_MODE: 'enforce' });
	assert.equal(ok.out.ships, 'false');
	assert.equal(mirrorName('@wolffm/logger'), '@hadoku/logger');
	assert.equal(mirrorName('@wolffm/repo-catalogue'), null);
});

const group = (changed) => ({
	'@wolffm/rooms-protocol': {
		versions: ['0.45.1'],
		prev: { 'package.json': manifest('@wolffm/rooms-protocol', '0.45.1', SHA_A), 'a.js': '1' },
		next: { 'package.json': manifest('@wolffm/rooms-protocol', '0.45.2', SHA_B), 'a.js': changed ? '2' : '1' },
	},
	'@wolffm/rooms-ui': {
		versions: ['0.45.1'],
		prev: {
			'package.json': manifest('@wolffm/rooms-ui', '0.45.1', SHA_A, { '@wolffm/rooms-protocol': '0.45.1' }),
		},
		next: {
			'package.json': manifest('@wolffm/rooms-ui', '0.45.2', SHA_B, { '@wolffm/rooms-protocol': '0.45.2' }),
		},
	},
});

test('a lockstep group whose only change is its sibling pins skips together', async () => {
	const f = fixture(group(false));
	const { out } = await f.run({ PUBLISH_GATE_MODE: 'enforce' });
	assert.deepEqual(out, { ships: 'false', verdict: 'skip', version: '0.45.1', reason: 'equal to the newest' });
	assert.equal(f.version(0), '0.45.1');
	assert.equal(f.version(1), '0.45.1');
});

test('one changed member ships the whole group, and nobody is set back', async () => {
	const f = fixture(group(true));
	const { out, record } = await f.run({ PUBLISH_GATE_MODE: 'enforce' });
	assert.equal(out.ships, 'true');
	assert.equal(record.reason, '@wolffm/rooms-protocol: changed package/a.js');
	assert.equal(f.version(1), '0.45.2');
});

test('a group whose members are at different versions ships', async () => {
	const g = group(false);
	g['@wolffm/rooms-ui'].versions = ['0.45.0'];
	g['@wolffm/rooms-ui'].prev['package.json'] = manifest('@wolffm/rooms-ui', '0.45.0', SHA_A, {
		'@wolffm/rooms-protocol': '0.45.0',
	});
	g['@wolffm/rooms-ui'].next['package.json'] = manifest('@wolffm/rooms-ui', '0.45.1', SHA_B, {
		'@wolffm/rooms-protocol': '0.45.1',
	});
	const f = fixture(g);
	const { out, record } = await f.run({ PUBLISH_GATE_MODE: 'enforce' });
	assert.equal(out.ships, 'true');
	assert.equal(record.reason, 'lockstep group at 0.45.2, 0.45.1');
});

test('an unknown mode fails rather than reading as report', async () => {
	const f = fixture(demo());
	await assert.rejects(f.run({ PUBLISH_GATE_MODE: 'enforced' }), /mode 'enforced' is neither report nor enforce/);
});
