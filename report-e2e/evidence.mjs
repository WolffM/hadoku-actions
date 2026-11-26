#!/usr/bin/env node
/**
 * The run's record and the failure evidence, where a person and the store can
 * both read it.
 *
 *   1. POST <store>/runs: environment, conclusion, artifact link and change
 *      window (monitoring-api migration 0023). A failed POST is appended to the
 *      post-failures file, so it fails the job like a failed results POST.
 *      Gzipped: Cloudflare's WAF 403s a plain JSON body whose commit subjects
 *      read as command injection (a backticked `python -m unittest`), and it
 *      decodes JSON \u escapes, so only a compressed body gets through
 *      (hadoku-actions#11).
 *   2. The CI log: an annotation per failure on its file and line, then a
 *      collapsed group per failed or flaky test with its whole error, where the
 *      trace is, and how to open it. Before this, a vitest suite with a JSON-only
 *      reporter printed nothing at all about why it failed.
 *   3. The job summary: the conclusion, counts, environment, failures, what
 *      changed since the last green run, and the artifact link.
 *
 * Env: PARSED, WINDOW, POST_FAILURES (paths), POST ('true'|'false'),
 * SERVICE_KEY, ENDPOINT, APP, REPO, RUNNER, GH_RUN_ID, RUN_ATTEMPT,
 * NIGHTLY_RUN_ID, EVENT, REF, HEAD_SHA, HOST, ARTIFACT_URL,
 * GITHUB_STEP_SUMMARY.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

const env = process.env;
const UA = 'Mozilla/5.0 (compatible; hadoku-report-e2e)';
// GitHub shows at most 10 error and 10 warning annotations per step.
const MAX_ANNOTATIONS = 10;
const MAX_GROUPS = 30;

const readJson = (p, fallback) => (p && existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : fallback);

const parsed = readJson(env.PARSED, null);
if (!parsed) {
	console.log(`::error::report-e2e: no parse output at ${env.PARSED}`);
	process.exit(1);
}
const window = readJson(env.WINDOW, {});
const { run, evidence } = parsed;
const artifactUrl = env.ARTIFACT_URL || null;

/** Escape a workflow-command property / message (GitHub's own rules). */
const prop = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A').replace(/:/g, '%3A').replace(/,/g, '%2C');
const msg = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');

export function runRecord() {
	return {
		gh_run_id: env.GH_RUN_ID,
		run_attempt: Number(env.RUN_ATTEMPT || 1),
		nightly_run_id: env.NIGHTLY_RUN_ID || null,
		repo: env.REPO,
		app: env.APP,
		event: env.EVENT || null,
		ref: env.REF || null,
		head_sha: env.HEAD_SHA || null,
		runner: env.RUNNER,
		tool_version: run.tool_version,
		node_version: process.version,
		host: env.HOST || null,
		report_status: run.report_status,
		passed: run.passed,
		failed: run.failed,
		flaky: run.flaky,
		skipped: run.skipped,
		test_wall_ms: run.test_wall_ms,
		classification: run.classification,
		evidence_missing: run.evidence_missing,
		artifact_url: artifactUrl,
		base_sha: window.base_sha ?? null,
		commits_since_base: window.commits_since_base ?? null,
		commits: window.commits ?? null,
		dep_bumps: window.dep_bumps ?? null,
	};
}

async function postRun(record) {
	const url = `${env.ENDPOINT.replace(/\/+(results\/*)?$/, '')}/runs`;
	try {
		const res = await fetch(url, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Content-Encoding': 'gzip',
				'X-User-Key': env.SERVICE_KEY,
				'User-Agent': UA,
			},
			body: gzipSync(JSON.stringify(record)),
			signal: AbortSignal.timeout(30_000),
		});
		if (res.ok) {
			console.log(`run record posted: ${record.classification} (${url})`);
			return null;
		}
		return `POST ${url} returned HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`;
	} catch (err) {
		return `POST ${url} failed: ${err.message}`;
	}
}

function printLog() {
	const failed = evidence.filter((e) => e.outcome === 'failed');
	const flaky = evidence.filter((e) => e.outcome === 'flaky');
	console.log(
		`e2e ${env.APP}: ${run.classification} — ${run.passed} passed, ${run.failed} failed, ${run.flaky} flaky, ${run.skipped} skipped` +
			(run.test_wall_ms !== null ? ` in ${(run.test_wall_ms / 1000).toFixed(1)}s` : '') +
			` (${env.RUNNER}${run.tool_version ? ` ${run.tool_version}` : ''}, node ${process.version}, ${env.HOST || 'unknown host'})`
	);
	for (const e of run.suite_errors) {
		console.log(`::error title=e2e ${env.APP}: error outside any test::${msg(e)}`);
	}
	for (const [list, level] of [
		[failed, 'error'],
		[flaky, 'warning'],
	]) {
		for (const e of list.slice(0, MAX_ANNOTATIONS)) {
			const [file, line] = (e.error_location ?? '').split(/:(?=\d+$)/);
			const where = file ? `file=${prop(file)}${line ? `,line=${line}` : ''},` : '';
			const title = `e2e ${e.outcome} (${e.failure_class}): ${e.test_name}`;
			console.log(`::${level} ${where}title=${prop(title)}::${msg((e.error ?? 'no error message').split('\n')[0])}`);
		}
	}
	for (const e of evidence.slice(0, MAX_GROUPS)) {
		console.log(`::group::${e.outcome.toUpperCase()} [${e.failure_class}] ${e.test_name} — ${e.error_location ?? e.spec}`);
		console.log(e.error ?? '(no error message in the report)');
		if (e.steps?.length) {
			console.log('steps:');
			for (const [title, ms, bad] of e.steps) console.log(`  ${bad ? '✗' : '·'} ${title} ${ms}ms`);
		}
		for (const a of e.attachments) console.log(`${a.name} (attempt ${a.retry + 1}): ${a.path}`);
		const trace = e.attachments.find((a) => a.name === 'trace');
		if (trace) {
			console.log(
				`open the trace: download the artifact${artifactUrl ? ` (${artifactUrl})` : ''}, then npx playwright show-trace <unzipped>/${trace.path.split('/').slice(-2).join('/')}`
			);
		}
		console.log('::endgroup::');
	}
	if (evidence.length > MAX_GROUPS) console.log(`(+${evidence.length - MAX_GROUPS} more failed/flaky tests in the report)`);
	if (run.evidence_missing > 0) {
		console.log(
			`::warning title=e2e ${env.APP}: failures without a trace::${run.evidence_missing} failed test(s) left no Playwright trace. Use @wolffm/e2e-harness/playwright's preset (trace: 'retain-on-failure'), or nobody can see what the browser did.`
		);
	}
}

function summary() {
	const lines = [];
	const icon = { green: '🟢', flaky: '🟡', app: '🔴', infra: '🟠', harness: '⚫' }[run.classification] ?? '';
	lines.push(`## ${icon} e2e ${env.APP}: ${run.classification}`);
	lines.push('');
	lines.push(
		`${run.passed} passed · ${run.failed} failed · ${run.flaky} flaky · ${run.skipped} skipped` +
			(run.test_wall_ms !== null ? ` · ${(run.test_wall_ms / 1000).toFixed(1)}s` : '') +
			` · report ${run.report_status}`
	);
	lines.push('');
	lines.push(
		`\`${(env.HEAD_SHA || '').slice(0, 7)}\` on \`${env.REF}\` · ${env.RUNNER} ${run.tool_version ?? ''} · node ${process.version} · ${env.HOST || 'unknown host'}`
	);
	if (run.suite_errors.length) {
		lines.push('', '### Errors outside any test', '');
		for (const e of run.suite_errors) lines.push('```', e, '```');
	}
	if (evidence.length) {
		lines.push('', '### Failed and flaky', '', '| | test | where | class | error |', '|---|---|---|---|---|');
		for (const e of evidence.slice(0, MAX_GROUPS)) {
			const first = (e.error ?? '').split('\n')[0].replace(/\|/g, '\\|').slice(0, 140);
			lines.push(`| ${e.outcome === 'failed' ? '✗' : '~'} | ${e.test_name.replace(/\|/g, '\\|')} | \`${e.error_location ?? e.spec}\` | ${e.failure_class} | ${first} |`);
		}
	}
	if (window.commits_since_base !== null && window.commits_since_base !== undefined) {
		lines.push('', `### Since the last green run (\`${window.base_sha.slice(0, 7)}\`): ${window.commits_since_base} commit(s)`, '');
		for (const b of window.dep_bumps) lines.push(`- \`${b.pkg}\` ${b.from} → ${b.to}`);
		for (const c of window.commits.slice(0, 15)) lines.push(`- \`${c.sha.slice(0, 7)}\` ${c.kind === 'deps' ? '(deps) ' : ''}${c.subject}`);
	} else if (window.error) {
		lines.push('', `Could not work out what changed since the last green run: ${window.error}`);
	}
	if (artifactUrl) lines.push('', `Traces, screenshots and logs: ${artifactUrl}`);
	if (run.classification !== 'green') {
		lines.push(
			'',
			`Compare with the last green run: \`GET https://hadoku.me/health/api/e2e/compare?app=${env.APP}&run=${env.GH_RUN_ID}\` (service key).`
		);
	}
	if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`);
}

printLog();
summary();
if (env.POST !== 'false') {
	const failure = env.SERVICE_KEY ? await postRun(runRecord()) : null;
	if (failure) {
		console.log(`::error::${msg(failure)}`);
		const prior = readJson(env.POST_FAILURES, []);
		writeFileSync(env.POST_FAILURES, JSON.stringify([...prior, failure]));
	}
}
