#!/usr/bin/env node
/**
 * Parse a Playwright/vitest JSON reporter file, or a pytest `--junitxml` XML
 * file, into one row per test: `{spec, test_name, outcome, attempts,
 * duration_ms}`, where `outcome` is `passed | failed | flaky | skipped`
 * (hadoku_site's wave3-2026-10-21.md §Contract vocabulary). The parsing is
 * `report-tests/parsers.mjs`, shared with report-tests; this file adds the e2e
 * contract (the zero-tests and skip rules) and the run record.
 *
 * Read from env (never argv, so the composite action's `run:` step stays a
 * one-liner): REPORT_PATH, RUNNER ('playwright' | 'vitest' | 'pytest'),
 * SKIP_ALLOW — the RAW `e2eSkipAllow` value from e2e.json as JSON text, or
 * the literal string 'null' when the file or the key is absent. This script
 * is the single place that judges its shape (see `validateSkipAllow`), so
 * action.yml's bash step never has to agree with it separately.
 *
 * Writes ONE JSON object to stdout: `{rows, failures, run, evidence}`.
 * `failures` is a list of human-readable reasons this run should fail the job
 * — the zero-tests rule, the skip rule, failed tests, errors outside any test
 * — so the caller's shell step only has to check whether that list is empty,
 * after it has already POSTed `rows`. `run` is the run record's parsed half
 * (report status, counts, tool version, wall time, classification); `evidence`
 * is each failed/flaky test with its error and attachment paths, for the log,
 * the step summary and the artifact upload.
 *
 * A missing or unparseable report is NOT an early exit: it is a `harness` run
 * with the reason in `run.suite_errors`, posted like any other. Exiting here
 * meant a crashed suite posted nothing and read as a night it did not run.
 *
 * Unknown `RUNNER` fails loudly — this script is the one place that decides,
 * so a caller never has to duplicate the check.
 */
import { readFileSync } from 'node:fs';
import { mergeSidecarErrors, parseReport } from '../report-tests/parsers.mjs';
import { classifyRun } from './classify.mjs';

const REPORT_PATH = process.env.REPORT_PATH;
const RUNNER = process.env.RUNNER;

if (!REPORT_PATH) {
	console.error('REPORT_PATH is required');
	process.exit(1);
}
if (RUNNER !== 'playwright' && RUNNER !== 'vitest' && RUNNER !== 'pytest') {
	console.error(
		`unknown runner '${RUNNER}' — only 'playwright', 'vitest' and 'pytest' are supported`
	);
	process.exit(1);
}

/**
 * The CANONICAL shape (manager decision, wave3-2026-10-21.md lane B note,
 * prompted by hadoku-task's real e2e.json): `e2eSkipAllow` is an object map
 * of `{"<test title>": "<one-line reason>"}` — the brief's own requirement is
 * "a one-line reason per allowed skip", and only a map can hold one. Absent
 * (no file, no key, or an explicit `null`) means an empty map: nothing is
 * allowed to skip. ANY other shape — an array (the old, retired convention),
 * a string, a number, or a map whose value for some key is not a non-empty
 * string — FAILS LOUDLY, naming the shape or the offending key. A silent
 * fallback to "nothing allowed" here is a worse bug than a loud one: it is
 * exactly what let hadoku-task's 80-entry array-shaped allow-list read as
 * empty and would have failed every one of its declared skips without
 * saying why.
 */
function validateSkipAllow(raw) {
	if (raw === null || raw === undefined) return {};
	if (Array.isArray(raw)) {
		throw new Error(
			`e2eSkipAllow must be an object map of {"<test title>": "<reason>"}, got an array (the old, retired shape) with ${raw.length} entr${raw.length === 1 ? 'y' : 'ies'}`
		);
	}
	if (typeof raw !== 'object') {
		throw new Error(
			`e2eSkipAllow must be an object map of {"<test title>": "<reason>"}, got ${typeof raw} (${JSON.stringify(raw)})`
		);
	}
	for (const [title, reason] of Object.entries(raw)) {
		if (typeof reason !== 'string' || reason.trim().length === 0) {
			throw new Error(
				`e2eSkipAllow['${title}'] must be a non-empty string reason, got ${JSON.stringify(reason)}`
			);
		}
	}
	return raw;
}

// Every problem below is a FAILURE ENTRY, never an early exit: an exit here
// meant nothing was posted, so a run whose setup crashed before writing its
// report left no row at all and read as "did not run" (the 2026-11-23
// measurement). Now it is posted as a `harness` run with the reason.
const failures = [];

let SKIP_ALLOW = {};
try {
	SKIP_ALLOW = validateSkipAllow(JSON.parse(process.env.SKIP_ALLOW ?? 'null'));
} catch (err) {
	failures.push(err.message);
}

let raw = null;
let readError = null;
try {
	raw = readFileSync(REPORT_PATH, 'utf8');
} catch (err) {
	readError = err.code ?? err.message;
}

const WORKSPACE = process.env.GITHUB_WORKSPACE || process.cwd();
const { reportStatus, rows, suiteErrors, toolVersion, testWallMs } = parseReport(RUNNER, raw, {
	workspace: WORKSPACE,
	reportPath: REPORT_PATH,
	readError,
});

// The harness presets write errors the runner's own report drops (a vitest
// hook's message) beside it as `<report>.errors.json`: `[{file, message}]`.
try {
	const sidecar = JSON.parse(readFileSync(`${REPORT_PATH}.errors.json`, 'utf8'));
	mergeSidecarErrors(suiteErrors, sidecar, { workspace: WORKSPACE, reportPath: REPORT_PATH });
} catch (err) {
	if (err.code !== 'ENOENT') suiteErrors.push(`${REPORT_PATH}.errors.json unreadable: ${err.message}`);
}

for (const e of suiteErrors) failures.push(`outside any test: ${e.split('\n')[0]}`);

// §Contract: fails the job when 0 tests ran...
if (rows.length === 0) {
	failures.push('0 tests ran');
}

// ...or when anything was skipped, unless that test's title is a key in the
// e2eSkipAllow map (validated above — every value still present is a
// non-empty string reason, though this check only needs the key).
const unallowedSkips = rows.filter(
	(r) => r.outcome === 'skipped' && !Object.prototype.hasOwnProperty.call(SKIP_ALLOW, r.test_name)
);
for (const r of unallowedSkips) {
	failures.push(`skipped without an e2eSkipAllow entry: '${r.test_name}' (${r.spec})`);
}

// The job conclusion is the test outcome AND the skip rule — a `failed` row
// must fail this action even though the runner's own exit code already
// failed the step, so report-e2e's exit status alone is a complete answer.
const failedRows = rows.filter((r) => r.outcome === 'failed');
for (const r of failedRows) {
	failures.push(`failed: '${r.test_name}' (${r.error_location ?? r.spec})`);
}

const count = (o) => rows.filter((r) => r.outcome === o).length;

// Evidence travels separately from `rows` (which is what gets POSTed): the
// attachment paths are this runner's filesystem, meaningless to the store.
const evidence = rows
	.filter((r) => r.outcome === 'failed' || r.outcome === 'flaky')
	.map(({ attachments, has_trace, ...r }) => ({ ...r, attachments: attachments ?? [], has_trace: has_trace ?? null }));
for (const r of rows) {
	delete r.attachments;
	delete r.has_trace;
}

const run = {
	report_status: reportStatus,
	tool_version: toolVersion,
	test_wall_ms: testWallMs,
	passed: count('passed'),
	failed: count('failed'),
	flaky: count('flaky'),
	skipped: count('skipped'),
	suite_errors: suiteErrors,
	// Only Playwright records traces; for the other runners this stays 0.
	evidence_missing:
		RUNNER === 'playwright' ? evidence.filter((e) => e.outcome === 'failed' && !e.has_trace).length : 0,
	classification: classifyRun({ reportStatus, rows, suiteErrors, unallowedSkips: unallowedSkips.length }),
};

process.stdout.write(JSON.stringify({ rows, failures, run, evidence }));
