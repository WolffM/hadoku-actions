#!/usr/bin/env node
/**
 * Parse a Playwright/vitest JSON reporter file, or a pytest `--junitxml` XML
 * file, into one row per test: `{spec, test_name, outcome, attempts,
 * duration_ms}`, where `outcome` is `passed | failed | flaky | skipped`
 * (hadoku_site's wave3-2026-10-21.md §Contract vocabulary).
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
import { isAbsolute, relative } from 'node:path';
import { classifyError, classifyRun } from './classify.mjs';

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

let reportStatus = 'ok';
const suiteErrors = [];

let raw = null;
try {
	raw = readFileSync(REPORT_PATH, 'utf8');
} catch (err) {
	reportStatus = 'missing';
	suiteErrors.push(
		`no report at ${REPORT_PATH} (${err.code ?? err.message}): the suite crashed, timed out or never started before writing it`
	);
}

// pytest's report is XML, not JSON — JSON.parse only applies to the other
// two runners, and parsePytest below reads `raw` directly.
let report = null;
if (raw !== null && RUNNER !== 'pytest') {
	try {
		report = JSON.parse(raw);
	} catch (err) {
		reportStatus = 'unparseable';
		suiteErrors.push(`report at ${REPORT_PATH} is not valid JSON: ${err.message}`);
	}
}

// --- Evidence helpers --------------------------------------------------------

const MAX_ERROR_CHARS = 1000;
const MAX_ERROR_LINES = 12;
const MAX_STEPS = 20;
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
const WORKSPACE = process.env.GITHUB_WORKSPACE || process.cwd();

/** An error message as a person reads it: no colour codes, the first lines only. */
function cleanError(message) {
	if (!message) return null;
	// Stack frames inside dependencies and Node itself say nothing about the
	// test; they only push the frames that do past the line cap.
	const lines = String(message)
		.replace(ANSI, '')
		.trim()
		.split('\n')
		.filter((l) => !/^\s+at .*(\/node_modules\/|node:internal|\(<anonymous>\)$)/.test(l));
	const text = lines.slice(0, MAX_ERROR_LINES).join('\n');
	return text.length > MAX_ERROR_CHARS ? text.slice(0, MAX_ERROR_CHARS) : text;
}

/** A path as the repo names it, so a GitHub annotation lands on the file. */
function repoPath(file) {
	if (!file) return null;
	return isAbsolute(file) ? relative(WORKSPACE, file) : file;
}

function location(file, line) {
	const f = repoPath(file);
	return f && line ? `${f}:${line}` : f;
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
				const row = {
					spec: spec.file ?? suite.file ?? 'unknown',
					test_name: spec.title,
					outcome,
					attempts: results.length || 1,
					duration_ms: results.reduce((sum, r) => sum + (r.duration ?? 0), 0),
				};
				if (outcome === 'failed' || outcome === 'flaky') {
					// A failed test's last attempt says why it ended red; a flaky
					// test's failing attempt says what went wrong before the retry.
					const bad =
						outcome === 'failed' ? results[results.length - 1] : results.find((r) => r.status !== 'passed');
					const err = bad?.error ?? bad?.errors?.[0];
					row.error = cleanError(err?.message ?? err?.value);
					const loc = bad?.errorLocation ?? err?.location;
					row.error_location = loc ? location(loc.file, loc.line) : null;
					row.failure_class = classifyError(row.error);
					row.attachments = results.flatMap((r) =>
						(r.attachments ?? []).filter((a) => a.path).map((a) => ({ name: a.name, path: a.path, retry: r.retry }))
					);
					row.has_trace = row.attachments.some((a) => a.name === 'trace');
				}
				const last = results[results.length - 1];
				if (last?.steps?.length) {
					row.steps = last.steps
						.slice(0, MAX_STEPS)
						.map((st) => [String(st.title).slice(0, 120), Math.round(st.duration ?? 0), Boolean(st.error)]);
				}
				rows.push(row);
			}
		}
		for (const sub of suite.suites ?? []) walk(sub);
	}
	for (const top of report.suites ?? []) walk(top);
	// Errors outside any test: a globalSetup or worker that crashed, a file that
	// failed to import. Its tests never ran, so no row carries the reason.
	for (const e of report.errors ?? []) {
		suiteErrors.push(cleanError(e.message ?? e.value) ?? 'an error outside any test');
	}
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
			const row = {
				spec: repoPath(file.name) ?? 'unknown',
				test_name,
				outcome,
				attempts: outcome === 'flaky' ? failures.length + 1 : 1,
				duration_ms: Math.round(a.duration ?? 0),
			};
			if (outcome === 'failed' || outcome === 'flaky') {
				const message = outcome === 'failed' ? failures[failures.length - 1] : failures[0];
				row.error = cleanError(message);
				row.error_location = vitestLocation(file.name, message);
				row.failure_class = classifyError(row.error);
			}
			rows.push(row);
		}
		// A file whose hooks threw (a beforeAll that could not reach its
		// backend): vitest marks the file failed with a message and its tests
		// skipped or absent. That message is the only record of why; with a
		// JSON-only reporter it reached no log at all (merchant, 2026-11-22).
		// vitest 4.1's JSON reporter leaves `message` EMPTY for a hook failure
		// (measured: a beforeAll that throws gives status 'failed', message '',
		// every test 'skipped'), so the shape alone has to say it. The text
		// comes from the @wolffm/e2e-harness/vitest reporter's sidecar file.
		const fileMessage = cleanError(file.message);
		const anyFailedTest = (file.assertionResults ?? []).some((a) => a.status === 'failed');
		if (file.status === 'failed' && !anyFailedTest) {
			suiteErrors.push(
				`${repoPath(file.name)}: ${fileMessage ?? 'a hook failed and its tests were skipped; the JSON report carries no message (use @wolffm/e2e-harness/vitest to record it)'}`
			);
		}
	}
	return rows;
}

/** `file.ts:LINE` from the first stack frame in the spec file itself. */
function vitestLocation(file, message) {
	if (!file || !message) return null;
	const base = file.split('/').pop().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const m = String(message).match(new RegExp(`${base}:(\\d+):\\d+`));
	return m ? location(file, m[1]) : repoPath(file);
}

/**
 * pytest's `--junitxml` writes `<testsuites><testsuite><testcase
 * classname="" name="" time="">` elements. This action has no package.json
 * and no node_modules (see README "Why referenced, not vendored" — a
 * composite action's `run:` steps are plain node, nothing to `npm install`),
 * so this is a deliberately narrow, non-DOM parser rather than a dependency:
 * pytest's own `_pytest/junitxml.py` (the `xunit2` family, the default since
 * pytest 6) always writes exactly `classname`/`name`/`time` as attributes,
 * standard XML entity escaping for text, and never CDATA — regex matching on
 * tag boundaries is safe against that one, known shape. It is not a general
 * XML parser and must not be reused as one.
 *
 * FLAKY MAPPING, verified empirically — nothing in pytest-rerunfailures' own
 * docs states this, so it was checked by actually running a 2-test suite
 * with `--reruns` and reading the XML it wrote (committed as
 * `fixtures/pytest-report.xml`, generated by `pytest --reruns 2
 * --junitxml=...` against a real flaky test, never hand-written):
 * pytest-rerunfailures sets `report.outcome = 'rerun'` for a retried attempt
 * and still fires `pytest_runtest_logreport`, but pytest core's junitxml
 * listener only emits a child element from its `passed`/`failed`/`skipped`
 * branches — `'rerun'` matches none of them, so a retried attempt gets no
 * `<failure>`/`<error>`/`<skipped>` of its own. Its teardown phase still
 * unconditionally opens and finalizes a `<testcase>` for ANY outcome, though
 * (`pytest_runtest_logreport`'s final `if report.when == 'teardown':`
 * block), so the retried attempt still lands as an EMPTY `<testcase>` — no
 * child element at all — under the same `classname`+`name` as the test's
 * later attempt(s). There is no dedicated `<rerun>` tag; the only signal
 * that a test reran is it appearing MORE THAN ONCE under the same
 * `classname`+`name`, consecutively, in document order. So: group
 * consecutive same-named `<testcase>` elements and read the outcome off the
 * LAST one in the group — group size 1 is a normal result; group size >1
 * ending in a `<failure>`/`<error>` is still `failed` (reruns exhausted
 * without a pass); group size >1 ending with no failure/error/skipped child
 * is `flaky` (passed after at least one rerun); a `<skipped>` test is never
 * rerun, so that group is always size 1.
 */
function parsePytest(xml) {
	const TESTCASE_RE = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g;
	const rows = [];
	let group = null; // { classname, name, entries: [{ time, failed, skipped }] }

	function flush() {
		if (!group) return;
		const entries = group.entries;
		const last = entries[entries.length - 1];
		let outcome;
		if (last.skipped) outcome = 'skipped';
		else if (last.failed) outcome = 'failed';
		else outcome = entries.length > 1 ? 'flaky' : 'passed';
		const duration_ms = Math.round(entries.reduce((sum, e) => sum + e.time, 0) * 1000);
		const row = {
			spec: group.classname,
			test_name: group.name,
			outcome,
			attempts: entries.length,
			duration_ms,
		};
		if (outcome === 'failed' || outcome === 'flaky') {
			const bad = outcome === 'failed' ? last : entries.find((e) => e.failed);
			row.error = cleanError(bad?.message);
			row.error_location = bad?.location ?? null;
			row.failure_class = classifyError(row.error);
		}
		rows.push(row);
		group = null;
	}

	let match;
	while ((match = TESTCASE_RE.exec(xml)) !== null) {
		const attrs = parseXmlAttrs(match[1]);
		const classname = decodeXmlEntities(attrs.classname ?? 'unknown');
		const name = decodeXmlEntities(attrs.name ?? 'unknown');
		const time = Number(attrs.time ?? '0') || 0;
		const inner = match[3] ?? '';
		const failed = /<(failure|error)\b/.test(inner);
		const skipped = /<skipped\b/.test(inner);
		const entry = { time, failed, skipped };
		if (failed) Object.assign(entry, pytestFailure(inner));

		if (group && group.classname === classname && group.name === name) {
			group.entries.push(entry);
		} else {
			flush();
			group = { classname, name, entries: [entry] };
		}
	}
	flush();
	return rows;
}

/**
 * The failure's message attribute and text. pytest's long repr ends with the
 * raising line as `path/to/test_x.py:123: AssertionError`; the last such line
 * is the location.
 */
function pytestFailure(inner) {
	const m = inner.match(/<(failure|error)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/);
	if (!m) return {};
	const attrs = parseXmlAttrs(m[2]);
	const text = decodeXmlEntities(m[3] ?? '');
	const head = decodeXmlEntities(attrs.message ?? '');
	const locs = [...text.matchAll(/^(\S+\.py):(\d+): /gm)];
	const loc = locs.length ? locs[locs.length - 1] : null;
	return {
		message: [head, text].filter(Boolean).join('\n'),
		location: loc ? location(loc[1], loc[2]) : null,
	};
}

function parseXmlAttrs(attrString) {
	const attrs = {};
	const ATTR_RE = /([a-zA-Z0-9_:-]+)\s*=\s*"([^"]*)"|([a-zA-Z0-9_:-]+)\s*=\s*'([^']*)'/g;
	let m;
	while ((m = ATTR_RE.exec(attrString)) !== null) {
		attrs[m[1] ?? m[3]] = m[2] ?? m[4];
	}
	return attrs;
}

// Decode in this order deliberately: every named/numeric entity EXCEPT
// `&amp;` first, then `&amp;` last — so an entity produced by decoding
// `&amp;` (e.g. the literal text `&lt;`, meaning a real ampersand followed by
// "lt;") is never re-decoded as if it were itself an escape.
function decodeXmlEntities(s) {
	return s
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
		.replace(/&#([0-9]+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
		.replace(/&amp;/g, '&');
}

let rows = [];
if (reportStatus === 'ok') {
	try {
		if (RUNNER === 'playwright') rows = parsePlaywright(report);
		else if (RUNNER === 'vitest') rows = parseVitest(report);
		else rows = parsePytest(raw);
	} catch (err) {
		reportStatus = 'unparseable';
		suiteErrors.push(`failed to parse the ${RUNNER} report: ${err.message}`);
		rows = [];
	}
	if (reportStatus === 'ok' && rows.length === 0) reportStatus = 'empty';
}

// The harness presets write errors the runner's own report drops (a vitest
// hook's message) beside it as `<report>.errors.json`: `[{file, message}]`.
try {
	const sidecar = JSON.parse(readFileSync(`${REPORT_PATH}.errors.json`, 'utf8'));
	if (Array.isArray(sidecar)) {
		for (const e of sidecar) {
			const msg = cleanError(e?.message);
			if (!msg) continue;
			const file = repoPath(e.file);
			// Replace the shape-only guess for that file with the real message.
			const i = suiteErrors.findIndex((x) => file && x.startsWith(`${file}: a hook failed`));
			if (i >= 0) suiteErrors[i] = `${file}: ${msg}`;
			else suiteErrors.push(file ? `${file}: ${msg}` : msg);
		}
	} else {
		suiteErrors.push(`${REPORT_PATH}.errors.json is not an array of {file, message}`);
	}
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
let testWallMs = null;
let toolVersion = null;
if (RUNNER === 'playwright' && report) {
	toolVersion = report.config?.version ?? null;
	testWallMs = typeof report.stats?.duration === 'number' ? Math.round(report.stats.duration) : null;
} else if (RUNNER === 'pytest' && raw) {
	const times = [...raw.matchAll(/<testsuite\b[^>]*?\btime="([\d.]+)"/g)].map((m) => Number(m[1]));
	if (times.length) testWallMs = Math.round(times.reduce((a, b) => a + b, 0) * 1000);
} else if (RUNNER === 'vitest' && report) {
	const ends = (report.testResults ?? []).map((f) => f.endTime).filter((n) => typeof n === 'number');
	if (typeof report.startTime === 'number' && ends.length) {
		testWallMs = Math.round(Math.max(...ends) - report.startTime);
	}
}

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
