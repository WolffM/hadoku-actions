/**
 * One parser per test runner, each turning the runner's own report into one
 * row per test: `{spec, test_name, outcome, attempts, duration_ms}`, where
 * `outcome` is `passed | failed | flaky | skipped`. A failed or flaky row also
 * carries `error`, `error_location` and `failure_class`.
 *
 * This is the single place the fleet reads a test report. report-e2e (e2e
 * suites, posting to `e2e_results`) and report-tests (every suite, unit and
 * e2e) both call `parseReport`; neither parses on its own.
 *
 * | runner     | report                                                      |
 * | ---------- | ----------------------------------------------------------- |
 * | playwright | `--reporter=json`                                           |
 * | vitest     | `--reporter=json` (+ the e2e-harness `.errors.json` sidecar) |
 * | jest       | `--json --outputFile=…` (the same shape vitest copies)      |
 * | pytest     | `--junitxml=…`                                              |
 * | node-test  | `--test-reporter=junit --test-reporter-destination=…`      |
 * | junit      | any other JUnit XML: cargo-nextest's `[profile.ci.junit]`   |
 *
 * Pure: no env, no filesystem. A runner this does not know throws, so a
 * caller never has to decide that separately.
 */
import { isAbsolute, relative } from 'node:path';
import { classifyError } from '../report-e2e/classify.mjs';

export const RUNNERS = ['playwright', 'vitest', 'jest', 'pytest', 'node-test', 'junit'];
const JSON_RUNNERS = new Set(['playwright', 'vitest', 'jest']);

const MAX_ERROR_CHARS = 1000;
const MAX_ERROR_LINES = 12;
const MAX_STEPS = 20;
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;

/**
 * @param {string} runner one of RUNNERS
 * @param {string|null} raw the report's text; null when the file was missing
 * @param {{workspace?: string, reportPath?: string, readError?: string|null}} [opts]
 *   workspace makes absolute paths repo-relative, so an annotation lands on
 *   the file; readError is why a missing report could not be read (ENOENT)
 * @returns {{reportStatus: 'ok'|'missing'|'unparseable'|'empty', rows: object[],
 *   suiteErrors: string[], toolVersion: string|null, testWallMs: number|null}}
 */
export function parseReport(runner, raw, opts = {}) {
	if (!RUNNERS.includes(runner)) {
		throw new Error(`unknown runner '${runner}': supported are ${RUNNERS.join(', ')}`);
	}
	const ctx = {
		workspace: opts.workspace ?? process.cwd(),
		suiteErrors: [],
		warnings: [],
		runner,
	};
	const where = opts.reportPath ?? 'the report';
	const out = (reportStatus, rows = [], extra = {}) => ({
		reportStatus,
		rows,
		suiteErrors: ctx.suiteErrors,
		toolVersion: extra.toolVersion ?? null,
		testWallMs: extra.testWallMs ?? null,
		warnings: ctx.warnings,
	});

	if (raw === null || raw === undefined) {
		ctx.suiteErrors.push(
			`no report at ${where}${opts.readError ? ` (${opts.readError})` : ''}: the suite crashed, timed out or never started before writing it`
		);
		return out('missing');
	}

	let report = raw;
	if (JSON_RUNNERS.has(runner)) {
		try {
			report = JSON.parse(raw);
		} catch (err) {
			ctx.suiteErrors.push(`${where} is not valid JSON: ${err.message}`);
			return out('unparseable');
		}
	}

	let rows;
	let extra = {};
	try {
		if (runner === 'playwright') {
			rows = parsePlaywright(report, ctx);
			extra = {
				toolVersion: report.config?.version ?? null,
				testWallMs: typeof report.stats?.duration === 'number' ? Math.round(report.stats.duration) : null,
			};
		} else if (runner === 'vitest' || runner === 'jest') {
			rows = parseJestShaped(report, ctx, runner);
			const ends = (report.testResults ?? []).map((f) => f.endTime).filter((n) => typeof n === 'number');
			if (typeof report.startTime === 'number' && ends.length) {
				extra.testWallMs = Math.round(Math.max(...ends) - report.startTime);
			}
		} else {
			({ rows, testWallMs: extra.testWallMs } = parseJunit(report, ctx));
		}
	} catch (err) {
		ctx.suiteErrors.push(`failed to parse the ${runner} report: ${err.message}`);
		return out('unparseable');
	}
	return out(rows.length ? 'ok' : 'empty', rows, extra);
}

/**
 * Errors a harness preset wrote beside the report (`<report>.errors.json`,
 * `[{file, message}]`) because the runner's own report drops them: a vitest
 * hook's message. Each replaces the shape-only guess for its file.
 */
export function mergeSidecarErrors(suiteErrors, sidecar, { workspace = process.cwd(), reportPath = 'report' } = {}) {
	if (!Array.isArray(sidecar)) {
		suiteErrors.push(`${reportPath}.errors.json is not an array of {file, message}`);
		return;
	}
	for (const e of sidecar) {
		const msg = cleanError(e?.message);
		if (!msg) continue;
		const file = repoPath(e.file, workspace);
		const i = suiteErrors.findIndex((x) => file && x.startsWith(`${file}: a hook failed`));
		if (i >= 0) suiteErrors[i] = `${file}: ${msg}`;
		else suiteErrors.push(file ? `${file}: ${msg}` : msg);
	}
}

/** An error message as a person reads it: no colour codes, the first lines only. */
export function cleanError(message) {
	if (!message) return null;
	// Stack frames inside dependencies and Node itself say nothing about the
	// test; they only push the frames that do past the line cap.
	const lines = String(message)
		.replace(ANSI, '')
		.trim()
		.split('\n')
		.filter((l) => !/^\s+at .*(\/node_modules\/|node:internal|node:async_hooks|\(<anonymous>\)$)/.test(l));
	const text = lines.slice(0, MAX_ERROR_LINES).join('\n');
	return text.length > MAX_ERROR_CHARS ? text.slice(0, MAX_ERROR_CHARS) : text;
}

/** A path as the repo names it. */
function repoPath(file, workspace) {
	if (!file) return null;
	const f = String(file).replace(/^file:\/\//, '');
	return isAbsolute(f) ? relative(workspace, f) : f;
}

function location(file, line, workspace) {
	const f = repoPath(file, workspace);
	return f && line ? `${f}:${line}` : f;
}

/** `file:LINE` from the first stack frame in the spec file itself. */
function frameIn(file, text, workspace) {
	if (!file || !text) return repoPath(file, workspace);
	const base = String(file).split('/').pop().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const m = String(text).match(new RegExp(`${base}:(\\d+)(?::\\d+)?`));
	return m ? location(file, m[1], workspace) : repoPath(file, workspace);
}

function failedFields(row, message, loc) {
	row.error = cleanError(message);
	row.error_location = loc;
	row.failure_class = classifyError(row.error);
}

/**
 * Playwright's JSON reporter nests `suites` arbitrarily (one level per
 * `describe`/file). Each `suites[].specs[]` is one test TITLE, and
 * `specs[].tests[]` is one per project/retry-group. `tests[].status` is the
 * whole-test outcome Playwright already computed, mapped rather than
 * re-derived from the attempts.
 */
function parsePlaywright(report, ctx) {
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
					const loc = bad?.errorLocation ?? err?.location;
					failedFields(row, err?.message ?? err?.value, loc ? location(loc.file, loc.line, ctx.workspace) : null);
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
		ctx.suiteErrors.push(cleanError(e.message ?? e.value) ?? 'an error outside any test');
	}
	return rows;
}

/**
 * vitest's and jest's JSON reporters share one shape: each `testResults[]` is
 * one FILE, and `assertionResults[]` is one test. Neither has a flaky status
 * or a retry count, but a test that failed before finishing `passed` keeps
 * those earlier `failureMessages`, so `passed` with messages is flaky and
 * `attempts` is `failureMessages.length + 1` (an undercount is possible only
 * for a flaky row). jest says `pending`/`todo`, vitest `skipped`/`todo`.
 */
function parseJestShaped(report, ctx, runner) {
	const rows = [];
	for (const file of report.testResults ?? []) {
		for (const a of file.assertionResults ?? []) {
			const failures = a.failureMessages ?? [];
			let outcome;
			if (a.status === 'passed') outcome = failures.length > 0 ? 'flaky' : 'passed';
			else if (a.status === 'failed') outcome = 'failed';
			else if (a.status === 'pending' || a.status === 'skipped' || a.status === 'todo' || a.status === 'disabled') {
				outcome = 'skipped';
			} else {
				throw new Error(`unrecognised ${runner} assertion status '${a.status}' for '${a.fullName}'`);
			}
			const test_name = [...(a.ancestorTitles ?? []), a.title].filter(Boolean).join(' > ') || a.title;
			const row = {
				spec: repoPath(file.name, ctx.workspace) ?? 'unknown',
				test_name,
				outcome,
				attempts: outcome === 'flaky' ? failures.length + 1 : 1,
				duration_ms: Math.round(a.duration ?? 0),
			};
			if (outcome === 'failed' || outcome === 'flaky') {
				const message = outcome === 'failed' ? failures[failures.length - 1] : failures[0];
				failedFields(row, message, frameIn(file.name, message, ctx.workspace));
			}
			rows.push(row);
		}
		// A file that failed with no failed test: a hook threw, or the file did
		// not import. vitest 4.1 leaves `message` EMPTY for a hook failure (its
		// tests read `skipped`), so the shape alone has to say it; the text comes
		// from the @wolffm/e2e-harness/vitest sidecar. jest keeps the message.
		const anyFailedTest = (file.assertionResults ?? []).some((a) => a.status === 'failed');
		if (file.status === 'failed' && !anyFailedTest) {
			const fileMessage = cleanError(file.message);
			ctx.suiteErrors.push(
				`${repoPath(file.name, ctx.workspace)}: ${fileMessage ?? 'a hook failed and its tests were skipped; the JSON report carries no message (use @wolffm/e2e-harness/vitest to record it)'}`
			);
		}
	}
	return rows;
}

/**
 * JUnit XML, as pytest, node:test and cargo-nextest write it. This repo's
 * actions have no node_modules (a composite action's `run:` is plain node), so
 * this is a narrow tokenizer over the shape those three write, not a general
 * XML parser: `<testsuite>` nesting, `<testcase>` with `name`, `classname`,
 * `time` and (node:test) `file`, and a `<failure>`, `<error>` or `<skipped>`
 * child. Text is entity-escaped, never CDATA, except in nextest's
 * `<system-out>`, which is skipped whole.
 *
 * Naming. A node:test testcase is `test_name: <describe> > … > <name>` from
 * the enclosing suites, and `spec: file`. Node before 23 writes no `file` and
 * `classname="test"` on every case (measured on 22.23.5), so its spec is
 * `unknown` and the report warns: two files' same-named tests are then one
 * test in the store. Any other JUnit (pytest, nextest) is `spec: classname`,
 * `test_name: name`, as report-e2e has always stored pytest rows.
 *
 * Reruns (pytest-rerunfailures, verified against a real `--reruns 2` report,
 * `report-e2e/fixtures/pytest-report.xml`): a retried attempt lands as an
 * EMPTY `<testcase>` under the same classname+name, consecutively. So
 * consecutive same-named cases are one test whose outcome is the LAST case's:
 * ending in a failure is `failed`, ending clean after more than one is `flaky`.
 * node:test never retries, so its cases are never grouped: on Node 22 two
 * describes' same-named tests (`lcpTone > x`, `tbtTone > x`) were read as one
 * flaky test before the describe chain was kept.
 *
 * node:test's hook failure (`type="hookFailed"`) says only "failed running
 * before hook"; the real error is the `cause:` in the text, appended here.
 */
// A tag's attributes, quote-aware: node:test escapes `<` but not `>` inside an
// attribute value (`name="a &lt;b>"`), so `[^>]*` would end the tag early.
const ATTRS = `((?:[^>"']|"[^"]*"|'[^']*')*?)`;

function parseJunit(xml, ctx) {
	const TOKEN = new RegExp(
		`<testsuite\\b${ATTRS}(\\/?)>|<\\/testsuite>|<testcase\\b${ATTRS}(?:\\/>|>([\\s\\S]*?)<\\/testcase>)|<!--\\s*duration_ms\\s+([\\d.]+)\\s*-->`,
		'g'
	);
	const stack = [];
	const topSuiteSeconds = [];
	let nodeDurationMs = null;
	const rows = [];
	let group = null;
	let unfiled = 0;

	function flush() {
		if (!group) return;
		const { entries } = group;
		const last = entries[entries.length - 1];
		let outcome;
		if (last.skipped) outcome = 'skipped';
		else if (last.failed) outcome = 'failed';
		else outcome = entries.length > 1 ? 'flaky' : 'passed';
		const row = {
			spec: group.spec,
			test_name: group.name,
			outcome,
			attempts: entries.length,
			duration_ms: Math.round(entries.reduce((sum, e) => sum + e.time, 0) * 1000),
		};
		if (outcome === 'failed' || outcome === 'flaky') {
			const bad = outcome === 'failed' ? last : entries.find((e) => e.failed);
			failedFields(row, bad?.message, bad?.location ?? null);
		}
		rows.push(row);
		group = null;
	}

	let m;
	while ((m = TOKEN.exec(xml)) !== null) {
		if (m[0].startsWith('<testsuite')) {
			const attrs = parseXmlAttrs(m[1]);
			if (stack.length === 0 && attrs.time) topSuiteSeconds.push(Number(attrs.time) || 0);
			if (!m[2]) stack.push(decodeXmlEntities(attrs.name ?? ''));
			continue;
		}
		if (m[0] === '</testsuite>') {
			stack.pop();
			continue;
		}
		if (m[5] !== undefined) {
			nodeDurationMs = Number(m[5]);
			continue;
		}
		const attrs = parseXmlAttrs(m[3]);
		const name = decodeXmlEntities(attrs.name ?? 'unknown');
		const classname = decodeXmlEntities(attrs.classname ?? 'unknown');
		const file = attrs.file ? decodeXmlEntities(attrs.file) : null;
		const nodeTest = ctx.runner === 'node-test';
		const spec = file ? repoPath(file, ctx.workspace) : nodeTest ? 'unknown' : classname;
		const test_name = file || nodeTest ? [...stack, name].join(' > ') : name;
		if (nodeTest && !file) unfiled++;
		const inner = (m[4] ?? '').replace(/<system-(out|err)>[\s\S]*?<\/system-\1>/g, '');
		const entry = {
			time: Number(attrs.time ?? '0') || 0,
			failed: /<(failure|error)\b/.test(inner),
			skipped: /<skipped\b/.test(inner),
		};
		if (entry.failed) Object.assign(entry, junitFailure(inner, file, ctx.workspace));

		if (!nodeTest && group && group.spec === spec && group.name === test_name)
			group.entries.push(entry);
		else {
			flush();
			group = { spec, name: test_name, entries: [entry] };
		}
	}
	flush();
	if (unfiled) {
		ctx.warnings.push(
			`${unfiled} node:test case(s) carry no file: Node before 23 writes none, so their spec is 'unknown' and same-named tests in different files are one test in the store; run the tests on Node 23 or later`
		);
	}
	const testWallMs =
		nodeDurationMs !== null
			? Math.round(nodeDurationMs)
			: topSuiteSeconds.length
				? Math.round(topSuiteSeconds.reduce((a, b) => a + b, 0) * 1000)
				: null;
	return { rows, testWallMs };
}

/** The failure's message and text, and where it was raised. */
function junitFailure(inner, file, workspace) {
	const m = inner.match(new RegExp(`<(failure|error)\\b${ATTRS}(?:\\/>|>([\\s\\S]*?)<\\/\\1>)`));
	if (!m) return {};
	const attrs = parseXmlAttrs(m[2]);
	const text = decodeXmlEntities(m[3] ?? '');
	const head = decodeXmlEntities(attrs.message ?? '');
	const cause = attrs.type === 'hookFailed' ? text.match(/^\s*cause: (.+)$/m)?.[1] : null;
	let loc = null;
	if (file) loc = frameIn(file, text, workspace);
	else {
		// pytest's long repr ends with the raising line as `path/x.py:123: Error`.
		const locs = [...text.matchAll(/^(\S+\.py):(\d+): /gm)];
		const last = locs[locs.length - 1];
		loc = last ? location(last[1], last[2], workspace) : null;
	}
	return {
		message: [cause ? `${head}: ${cause}` : head, text].filter(Boolean).join('\n'),
		location: loc,
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

// Every entity except `&amp;` first, `&amp;` last, so a decoded `&amp;lt;`
// (the literal text `&lt;`) is never decoded a second time.
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
