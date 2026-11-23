#!/usr/bin/env node
/**
 * What changed since this app's last green run on this branch?
 *
 * An "untouched" repo is not unchanged: each child gets 5-18 automatic
 * `@wolffm/*` update commits a day, so a nightly red with no human commit
 * behind it was usually one of those (the 2026-11-23 measurement). This names
 * them, so a red points at the bump that broke it.
 *
 *   1. GET <store>/runs/last-green?app&ref  -> the last green run's head_sha
 *   2. GET GitHub /compare/<base>...<head>  -> the commits in between, and the
 *      `@wolffm/*` (and any other) version changes in their package.json diffs
 *
 * Env: ENDPOINT (the results URL; runs live beside it), SERVICE_KEY, APP,
 * REF, HEAD_SHA, REPO (owner/name), GH_TOKEN, GITHUB_API_URL.
 * Writes ONE JSON object to the file named by OUT: `{base_sha, commits_since_base, commits,
 * dep_bumps}` (all null when there is no green run to compare with), or
 * `{error}`. Never exits non-zero: a missing window is a warning on the run,
 * not a reason to lose its results. The warning is printed, never swallowed.
 */

const { ENDPOINT, SERVICE_KEY, APP, REF, HEAD_SHA, REPO, GH_TOKEN } = process.env;
const API = process.env.GITHUB_API_URL || 'https://api.github.com';
const UA = 'Mozilla/5.0 (compatible; hadoku-report-e2e)';
const TIMEOUT_MS = 20_000;
export const MAX_COMMITS = 40;

const EMPTY = { base_sha: null, commits_since_base: null, commits: null, dep_bumps: null };

/** A commit the update bots made, or one whose subject says it only moves versions. */
export function commitKind(subject, author) {
	if (/\b(github-actions|dependabot|renovate)(\[bot\])?$/i.test(author ?? '')) return 'deps';
	if (/auto-update @wolffm|^chore\(deps\)|^(build|chore)?\(?deps?\)?:? ?bump\b|^bump\b/i.test(subject)) {
		return 'deps';
	}
	return 'code';
}

/**
 * Version changes in a package.json patch: `-  "pkg": "^1.2.3",` against
 * `+  "pkg": "^1.2.4",`. Only names that appear on both sides with different
 * values; an added or removed dependency is a code change, not a bump.
 */
export function bumpsFromPatch(patch) {
	const before = new Map();
	const after = new Map();
	for (const line of (patch ?? '').split('\n')) {
		const m = line.match(/^([-+])\s*"((?:@[\w.-]+\/)?[\w.-]+)":\s*"([^"]+)"/);
		if (!m) continue;
		(m[1] === '-' ? before : after).set(m[2], m[3]);
	}
	const out = [];
	for (const [pkg, from] of before) {
		const to = after.get(pkg);
		if (to !== undefined && to !== from) out.push({ pkg, from, to });
	}
	return out;
}

async function get(url, headers) {
	const res = await fetch(url, { headers: { 'User-Agent': UA, ...headers }, signal: AbortSignal.timeout(TIMEOUT_MS) });
	if (!res.ok) throw new Error(`${url.split('?')[0]} -> HTTP ${res.status}`);
	return res.json();
}

async function main() {
	if (!SERVICE_KEY || !ENDPOINT || !APP || !HEAD_SHA) return EMPTY;
	const store = ENDPOINT.replace(/\/+(results\/*)?$/, '');
	const q = new URLSearchParams({ app: APP, ...(REF ? { ref: REF } : {}) });
	const { run } = await get(`${store}/runs/last-green?${q}`, { 'X-User-Key': SERVICE_KEY });
	const base = run?.head_sha ?? null;
	if (!base) return EMPTY;
	if (base === HEAD_SHA) return { base_sha: base, commits_since_base: 0, commits: [], dep_bumps: [] };

	const cmp = await get(`${API}/repos/${REPO}/compare/${base}...${HEAD_SHA}`, {
		Authorization: `Bearer ${GH_TOKEN}`,
		Accept: 'application/vnd.github+json',
		'X-GitHub-Api-Version': '2022-11-28',
	});
	const commits = (cmp.commits ?? [])
		.map((c) => {
			const subject = (c.commit?.message ?? '').split('\n')[0];
			return { sha: c.sha, subject, kind: commitKind(subject, c.author?.login ?? c.commit?.author?.name) };
		})
		.reverse() // newest first
		.slice(0, MAX_COMMITS);
	const dep_bumps = (cmp.files ?? [])
		.filter((f) => /(^|\/)package\.json$/.test(f.filename))
		.flatMap((f) => bumpsFromPatch(f.patch).map((b) => ({ ...b, sha: HEAD_SHA })));
	return { base_sha: base, commits_since_base: cmp.total_commits ?? commits.length, commits, dep_bumps };
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const { writeFileSync } = await import('node:fs');
	let out;
	try {
		out = await main();
	} catch (err) {
		console.log(`::warning::report-e2e could not work out what changed since the last green run: ${err.message}`);
		out = { ...EMPTY, error: err.message };
	}
	writeFileSync(process.env.OUT, JSON.stringify(out));
	if (out.commits_since_base !== null) {
		const deps = out.commits.filter((c) => c.kind === 'deps').length;
		console.log(
			`since the last green run (${out.base_sha.slice(0, 7)}): ${out.commits_since_base} commit(s), ${deps} of them dependency updates, ${out.dep_bumps.length} version change(s)`
		);
		for (const b of out.dep_bumps) console.log(`  ${b.pkg} ${b.from} -> ${b.to}`);
		for (const c of out.commits) console.log(`  ${c.sha.slice(0, 7)} [${c.kind}] ${c.subject}`);
	}
}
