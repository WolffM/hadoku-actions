#!/usr/bin/env node
/**
 * Parse a Playwright or vitest JSON reporter file into one row per test:
 * `{spec, test_name, outcome, attempts, duration_ms}`, where `outcome` is
 * `passed | failed | flaky | skipped` (hadoku_site's wave3-2026-10-21.md
 * §Contract vocabulary).
 *
 * Read from env (never argv, so the composite action's `run:` step stays a
 * one-liner): REPORT_PATH, RUNNER ('playwright' | 'vitest'), SKIP_ALLOW (a
 * JSON array of allowed-skip test titles, possibly empty).
 *
 * Writes ONE JSON object to stdout: `{rows, failures}`. `failures` is a list
 * of human-readable reasons this run should fail the job — the zero-tests
 * rule and the skip rule — so the caller's shell step only has to check
 * whether that list is empty, after it has already POSTed `rows`.
 *
 * Unknown `RUNNER` fails loudly (pytest is wave 4) — this script is the one
 * place that decides, so a caller never has to duplicate the check.
 */
import { readFileSync } from 'node:fs';

const REPORT_PATH = process.env.REPORT_PATH;
const RUNNER = process.env.RUNNER;
const SKIP_ALLOW = JSON.parse(process.env.SKIP_ALLOW || '[]');

if (!REPORT_PATH) {
	console.error('REPORT_PATH is required');
	process.exit(1);
}
if (RUNNER !== 'playwright' && RUNNER !== 'vitest') {
	console.error(
		`unknown runner '${RUNNER}' — only 'playwright' and 'vitest' are supported (pytest is wave 4)`
	);
	process.exit(1);
}

let raw;
try {
	raw = readFileSync(REPORT_PATH, 'utf8');
} catch (err) {
	console.error(`could not read report at ${REPORT_PATH}: ${err.message}`);
	process.exit(1);
}

let report;
try {
	report = JSON.parse(raw);
} catch (err) {
	console.error(`report at ${REPORT_PATH} is not valid JSON: ${err.message}`);
	process.exit(1);
}

/**
 * Playwright's JSON reporter nests `suites` arbitrarily (one level per
 * `describe`/file). Each `suites[].specs[]` is one test TITLE, and
 * `specs[].tests[]` is one per project/retry-group — almost always one, in a
 * single-project suite. `tests[].status` is the whole-test outcome Playwright
 * itself already computed (`expected|unexpected|flaky|skipped`), so this maps
 * it rather than re-deriving it from the individual attempt results.
 */
function parsePlaywright(report) {
	const STATUS_MAP = { expected: 'passed', unexpected: 'failed', flaky: 'flaky', skipped: 'skipped' };
	const rows = [];

	function walk(suite) {
		for (const spec of suite.specs ?? []) {
			for (const test of spec.tests ?? []) {
				const outcome = STATUS_MAP[test.status];
				if (!outcome) {
					throw new Error(`unrecognised Playwright test status '${test.status}' for '${spec.title}'`);
				}
				const results = test.results ?? [];
				rows.push({
					spec: spec.file ?? suite.file ?? 'unknown',
					test_name: spec.title,
					outcome,
					attempts: results.length || 1,
					duration_ms: results.reduce((sum, r) => sum + (r.duration ?? 0), 0),
				});
			}
		}
		for (const sub of suite.suites ?? []) walk(sub);
	}
	for (const top of report.suites ?? []) walk(top);
	return rows;
}

/**
 * vitest's JSON reporter (Jest-shaped) has no `suites` nesting: each
 * `testResults[]` is one FILE, and `assertionResults[]` is one test. There is
 * no `attempts`/retry count field, and no dedicated "flaky" status — but a
 * test that failed at least once before finishing `passed` still carries
 * those earlier `failureMessages`, which is the only signal available. A
 * `status: 'passed'` row with a non-empty `failureMessages` is therefore
 * flaky; everything else maps directly.
 *
 * KNOWN GAP: vitest's JSON reporter does not expose how many attempts a
 * flaky test took (no `retryReasons` in 4.1.11), so `attempts` is
 * `failureMessages.length + 1` for a flaky row and `1` for everything else —
 * an undercount is possible only for a flaky row, never for the outcome
 * itself.
 */
function parseVitest(report) {
	const rows = [];
	for (const file of report.testResults ?? []) {
		for (const a of file.assertionResults ?? []) {
			const failures = a.failureMessages ?? [];
			let outcome;
			if (a.status === 'passed') outcome = failures.length > 0 ? 'flaky' : 'passed';
			else if (a.status === 'failed') outcome = 'failed';
			else if (a.status === 'pending' || a.status === 'skipped' || a.status === 'todo') {
				outcome = 'skipped';
			} else {
				throw new Error(`unrecognised vitest assertion status '${a.status}' for '${a.fullName}'`);
			}
			const test_name = [...(a.ancestorTitles ?? []), a.title].filter(Boolean).join(' > ') || a.title;
			rows.push({
				spec: file.name ?? 'unknown',
				test_name,
				outcome,
				attempts: outcome === 'flaky' ? failures.length + 1 : 1,
				duration_ms: Math.round(a.duration ?? 0),
			});
		}
	}
	return rows;
}

let rows;
try {
	rows = RUNNER === 'playwright' ? parsePlaywright(report) : parseVitest(report);
} catch (err) {
	console.error(`failed to parse ${RUNNER} report: ${err.message}`);
	process.exit(1);
}

const failures = [];

// §Contract: fails the job when 0 tests ran...
if (rows.length === 0) {
	failures.push('0 tests ran');
}

// ...or when anything was skipped, unless that test's title is allow-listed.
const allowSet = new Set(SKIP_ALLOW);
const unallowedSkips = rows.filter((r) => r.outcome === 'skipped' && !allowSet.has(r.test_name));
for (const r of unallowedSkips) {
	failures.push(`skipped without an e2eSkipAllow entry: '${r.test_name}' (${r.spec})`);
}

// The job conclusion is the test outcome AND the skip rule — a `failed` row
// must fail this action even though the runner's own exit code already
// failed the step, so report-e2e's exit status alone is a complete answer.
const failedRows = rows.filter((r) => r.outcome === 'failed');
for (const r of failedRows) {
	failures.push(`failed: '${r.test_name}' (${r.spec})`);
}

process.stdout.write(JSON.stringify({ rows, failures }));
