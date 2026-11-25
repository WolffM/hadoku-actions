#!/usr/bin/env node
/**
 * report-tests: read every report a job's test step wrote, normalise them into
 * ONE document, write it, and print what it holds. post.mjs then posts it to
 * the fleet test store (hadoku_site
 * docs/planning/unified-test-reporting-2026-11-23.md).
 *
 * Env, never argv, so action.yml's step stays a one-liner:
 *   REPORTS  one report per line, `<runner> <path>` (runner: parsers.mjs RUNNERS)
 *   SUITE    the suite's stable name within the repo (default: the job id)
 *   KIND     unit | e2e
 *   OUT      where the document is written
 *   GITHUB_* the run's identity, as Actions sets it
 *
 * Advisory: every problem is a `::warning::`, and the exit is 0. The test
 * step's own exit code already fails a red job; this step must not add a red
 * of its own until its findings have been read (a new check starts quiet).
 */
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { mergeSidecarErrors, parseReport, RUNNERS } from './parsers.mjs';

const env = process.env;
const workspace = env.GITHUB_WORKSPACE || process.cwd();
const warnings = [];
const warn = (msg) => {
	warnings.push(msg);
	console.log(`::warning title=report-tests::${msg.replace(/\r?\n/g, '%0A')}`);
};

const kind = env.KIND || 'unit';
if (kind !== 'unit' && kind !== 'e2e') warn(`kind '${kind}' is not unit or e2e`);
const suite = env.SUITE || env.GITHUB_JOB || 'tests';

const specs = String(env.REPORTS ?? '')
	.split('\n')
	.map((l) => l.trim())
	.filter(Boolean)
	.map((l) => {
		const [runner, ...rest] = l.split(/\s+/);
		return { runner, path: rest.join(' ') };
	});
if (!specs.length) warn('no reports given: set `reports` to one `<runner> <path>` per line');

const reports = [];
const tests = [];
for (const { runner, path } of specs) {
	if (!RUNNERS.includes(runner) || !path) {
		warn(`'${runner} ${path}': each line is '<runner> <path>', runner one of ${RUNNERS.join(', ')}`);
		continue;
	}
	let raw = null;
	let readError = null;
	try {
		raw = readFileSync(path, 'utf8');
	} catch (err) {
		readError = err.code ?? err.message;
	}
	const parsed = parseReport(runner, raw, { workspace, reportPath: path, readError });
	try {
		mergeSidecarErrors(parsed.suiteErrors, JSON.parse(readFileSync(`${path}.errors.json`, 'utf8')), {
			workspace,
			reportPath: path,
		});
	} catch (err) {
		if (err.code !== 'ENOENT') parsed.suiteErrors.push(`${path}.errors.json unreadable: ${err.message}`);
	}
	const count = (o) => parsed.rows.filter((r) => r.outcome === o).length;
	reports.push({
		runner,
		path,
		report_status: parsed.reportStatus,
		tool_version: parsed.toolVersion,
		test_wall_ms: parsed.testWallMs,
		tests: parsed.rows.length,
		passed: count('passed'),
		failed: count('failed'),
		flaky: count('flaky'),
		skipped: count('skipped'),
		suite_errors: parsed.suiteErrors,
	});
	for (const r of parsed.rows) {
		// Attachment paths are this runner's filesystem; they travel with the
		// artifact, never the document.
		const { attachments: _a, has_trace: _t, ...row } = r;
		tests.push({ runner, ...row });
	}
	if (parsed.reportStatus !== 'ok') warn(`${runner} ${path}: report ${parsed.reportStatus}`);
	for (const e of parsed.suiteErrors) warn(`${path}: outside any test: ${e.split('\n')[0]}`);
}

const doc = {
	schema: 1,
	repo: env.GITHUB_REPOSITORY ?? null,
	suite,
	kind,
	event: env.GITHUB_EVENT_NAME ?? null,
	ref: env.GITHUB_REF_NAME ?? null,
	sha: env.GITHUB_SHA ?? null,
	run_id: env.GITHUB_RUN_ID ? Number(env.GITHUB_RUN_ID) : null,
	run_attempt: env.GITHUB_RUN_ATTEMPT ? Number(env.GITHUB_RUN_ATTEMPT) : null,
	job: env.GITHUB_JOB ?? null,
	host: env.RUNNER_NAME ?? null,
	reports,
	tests,
	warnings,
};
const out = env.OUT || 'report-tests.json';
writeFileSync(out, JSON.stringify(doc));

// --- What a person reads in the log and the step summary ---------------------
const total = (k) => reports.reduce((s, r) => s + r[k], 0);
const lines = [];
lines.push(`## report-tests: ${suite} (${kind})`);
lines.push('');
lines.push('| runner | report | status | tests | passed | failed | flaky | skipped | wall |');
lines.push('| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |');
for (const r of reports) {
	const wall = r.test_wall_ms === null ? '—' : `${(r.test_wall_ms / 1000).toFixed(1)} s`;
	lines.push(
		`| ${r.runner} | \`${r.path}\` | ${r.report_status} | ${r.tests} | ${r.passed} | ${r.failed} | ${r.flaky} | ${r.skipped} | ${wall} |`
	);
}
lines.push('');
lines.push(
	`${total('tests')} tests: ${total('passed')} passed, ${total('failed')} failed, ${total('flaky')} flaky, ${total('skipped')} skipped. Document: \`${out}\` (${Buffer.byteLength(JSON.stringify(doc))} bytes).`
);
const slow = [...tests].sort((a, b) => b.duration_ms - a.duration_ms).slice(0, 10);
if (slow.length) {
	lines.push('');
	lines.push('Slowest:');
	lines.push('');
	for (const t of slow) lines.push(`- ${t.duration_ms} ms \`${t.spec}\` ${t.test_name}`);
}
const red = tests.filter((t) => t.outcome === 'failed' || t.outcome === 'flaky');
if (red.length) {
	lines.push('');
	lines.push('Failed or flaky:');
	lines.push('');
	for (const t of red.slice(0, 50)) {
		lines.push(`- ${t.outcome} \`${t.error_location ?? t.spec}\` ${t.test_name}: ${(t.error ?? '').split('\n')[0]}`);
	}
}
const text = lines.join('\n');
console.log(text);
if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${text}\n`);
