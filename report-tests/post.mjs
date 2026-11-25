#!/usr/bin/env node
/**
 * report-tests, Phase 1: post the document cli.mjs wrote to the fleet test
 * store (hadoku_site monitoring-api `POST /health/api/tests/runs`, migration
 * 0024), gzipped, with the repo's service key.
 *
 * Env:
 *   DOC          the document's path (cli.mjs's OUT)
 *   SERVICE_KEY  the repo's KEY_SERVICE_<APP>, sent as X-User-Key
 *   ENDPOINT     the store's ingest URL
 *
 * Advisory, like the reader: an unset key, a refusal or an unreachable store
 * is a `::warning::` and exit 0. The store upserts on (repo, suite, run,
 * attempt), so the one retry after a network error or a 5xx cannot count a
 * run twice.
 */
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';

// Cloudflare refuses a bare runtime User-Agent on hadoku.me
// (hadoku_site docs/operations/CLOUDFLARE_UA_BLOCK.md).
export const UA = 'Mozilla/5.0 (compatible; hadoku-report-tests)';
export const TIMEOUT_MS = 30_000;

/** @returns {Promise<{ ok: boolean, message: string }>} */
export async function postDocument({ doc, key, endpoint, fetchImpl = fetch, retryDelayMs = 3000 }) {
	if (!key) return { ok: false, message: 'no service key (`key` input unset): the document was not posted' };
	if (!endpoint) return { ok: false, message: 'no endpoint: the document was not posted' };
	const body = gzipSync(Buffer.from(typeof doc === 'string' ? doc : JSON.stringify(doc)));
	let last = '';
	for (let attempt = 1; attempt <= 2; attempt++) {
		try {
			const res = await fetchImpl(endpoint, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'Content-Encoding': 'gzip',
					'X-User-Key': key,
					'User-Agent': UA,
				},
				body,
				signal: AbortSignal.timeout(TIMEOUT_MS),
			});
			const text = await res.text();
			if (res.ok) return { ok: true, message: `posted ${body.length} bytes gzipped: ${text.slice(0, 300)}` };
			last = `HTTP ${res.status}: ${text.slice(0, 300)}`;
			if (res.status < 500) break;
		} catch (err) {
			last = `${err.name}: ${err.message}`;
		}
		if (attempt === 1) await new Promise((r) => setTimeout(r, retryDelayMs));
	}
	return { ok: false, message: `the store refused or could not be reached (${last})` };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
	const env = process.env;
	let doc = null;
	try {
		doc = readFileSync(env.DOC, 'utf8');
	} catch (err) {
		console.log(`::warning title=report-tests::no document to post at ${env.DOC}: ${err.code ?? err.message}`);
	}
	if (doc !== null) {
		const r = await postDocument({ doc, key: env.SERVICE_KEY, endpoint: env.ENDPOINT });
		console.log(r.ok ? `report-tests: ${r.message}` : `::warning title=report-tests::${r.message}`);
	}
}
