// Every fixture here is a runner's REAL output, never hand-written: node:test
// 24 (`--test-reporter=junit`) and jest 30 (`--json`) over a suite with a pass,
// a fail, a skip, a todo, nested describes and a throwing before-all hook, with
// only the checkout path rewritten to /home/runner/work/app/app. The
// Playwright, vitest and pytest fixtures are report-e2e's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseReport, RUNNERS } from './parsers.mjs';

const here = new URL('.', import.meta.url).pathname;
const WS = '/home/runner/work/app/app';
const read = (p) => readFileSync(join(here, p), 'utf8');
const byName = (rows) => Object.fromEntries(rows.map((r) => [r.test_name, r]));

test('node:test JUnit: describe nesting, escapes, skips and todos, the hook cause', () => {
	const r = parseReport('node-test', read('fixtures/node-test-report.xml'), { workspace: WS });
	assert.equal(r.reportStatus, 'ok');
	assert.equal(r.testWallMs, 171);
	assert.equal(r.rows.length, 7);
	const t = byName(r.rows);
	assert.equal(t['top-level passes'].outcome, 'passed');
	assert.equal(t['top-level passes'].spec, 'sample.test.mjs');
	assert.equal(t['top-level skipped'].outcome, 'skipped');
	assert.equal(t['top-level todo'].outcome, 'skipped');
	assert.equal(t['a suite > nested passes'].outcome, 'passed');
	const deep = t['a suite > inner > deep fails & <escapes>'];
	assert.equal(deep.outcome, 'failed');
	assert.equal(deep.error_location, 'sample.test.mjs:10');
	assert.match(deep.error, /^boom "quoted" <tag>/);
	const hook = t['never runs'];
	assert.equal(hook.outcome, 'failed');
	assert.equal(hook.spec, 'second.test.mjs');
	assert.match(hook.error, /^failed running before hook: Error: setup could not reach its backend/);
	assert.equal(hook.error_location, 'second.test.mjs:2');
	assert.ok(!/node:internal/.test(hook.error), 'Node-internal frames are dropped');
});

test('jest JSON: ancestor titles, pending and todo, a file that failed to run', () => {
	const r = parseReport('jest', read('fixtures/jest-report.json'), { workspace: WS });
	assert.equal(r.reportStatus, 'ok');
	assert.equal(r.rows.length, 7);
	const t = byName(r.rows);
	assert.equal(t['top-level skipped'].outcome, 'skipped');
	assert.equal(t['top-level todo'].outcome, 'skipped');
	assert.equal(t['a suite > inner > deep fails'].error_location, 'sample.test.js:8');
	assert.equal(t['never runs'].outcome, 'failed');
	assert.match(t['never runs'].error, /setup could not reach its backend/);
	assert.equal(r.suiteErrors.length, 1);
	assert.match(r.suiteErrors[0], /^broken\.test\.js: ● Test suite failed to run/);
});

test('pytest JUnit: a rerun that passed is flaky, a failure names its line', () => {
	const flaky = parseReport('pytest', read('../report-e2e/fixtures/pytest-report.xml'));
	assert.deepEqual(
		flaky.rows.map((r) => [r.test_name, r.outcome, r.attempts]),
		[
			['test_a_passing_test', 'passed', 1],
			['test_a_flaky_test_that_passes_on_rerun', 'flaky', 2],
		]
	);
	const red = byName(parseReport('pytest', read('../report-e2e/fixtures/pytest-failure-report.xml')).rows);
	assert.equal(red.test_menu_not_clipped.error_location, 'tests/test_cards.py:12');
	assert.equal(red.test_menu_not_clipped.spec, 'tests.test_cards');
});

test('the JSON runners keep report-e2e fixtures readable', () => {
	for (const [runner, f] of [
		['playwright', 'playwright-report.json'],
		['vitest', 'vitest-report.json'],
	]) {
		const r = parseReport(runner, read(`../report-e2e/fixtures/${f}`));
		assert.equal(r.reportStatus, 'ok', f);
		assert.ok(r.rows.length > 0, f);
	}
});

test('missing, unparseable, empty and unknown are told apart', () => {
	assert.equal(parseReport('jest', null, { readError: 'ENOENT' }).reportStatus, 'missing');
	assert.match(parseReport('jest', null, { readError: 'ENOENT', reportPath: 'r.json' }).suiteErrors[0], /^no report at r\.json \(ENOENT\)/);
	assert.equal(parseReport('vitest', '{not json').reportStatus, 'unparseable');
	assert.equal(parseReport('node-test', '<testsuites></testsuites>').reportStatus, 'empty');
	assert.throws(() => parseReport('cypress', '{}'), /unknown runner 'cypress'/);
	assert.deepEqual(RUNNERS, ['playwright', 'vitest', 'jest', 'pytest', 'node-test', 'junit']);
});

test('cli: several reports in one job become one document, and nothing fails', () => {
	const dir = mkdtempSync(join(tmpdir(), 'report-tests-'));
	const out = join(dir, 'doc.json');
	const stdout = execFileSync('node', [join(here, 'cli.mjs')], {
		encoding: 'utf8',
		env: {
			PATH: process.env.PATH,
			GITHUB_WORKSPACE: WS,
			REPORTS: `node-test ${join(here, 'fixtures/node-test-report.xml')}\njest ${join(here, 'fixtures/jest-report.json')}\nvitest ${join(dir, 'never-written.json')}\ncypress x.json`,
			SUITE: 'unit',
			KIND: 'unit',
			OUT: out,
		},
	});
	const doc = JSON.parse(readFileSync(out, 'utf8'));
	assert.equal(doc.schema, 1);
	assert.equal(doc.suite, 'unit');
	assert.deepEqual(
		doc.reports.map((r) => [r.runner, r.report_status, r.tests]),
		[
			['node-test', 'ok', 7],
			['jest', 'ok', 7],
			['vitest', 'missing', 0],
		]
	);
	assert.equal(doc.tests.length, 14);
	assert.ok(doc.tests.every((t) => t.runner && t.spec && t.test_name && t.outcome));
	assert.ok(doc.warnings.some((w) => /cypress x\.json/.test(w)));
	assert.ok(doc.warnings.some((w) => /never-written\.json: report missing/.test(w)));
	assert.match(stdout, /14 tests: 4 passed, 6 failed, 0 flaky, 4 skipped/);
});
