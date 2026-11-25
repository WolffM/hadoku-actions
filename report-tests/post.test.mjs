import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { gunzipSync } from 'node:zlib';
import { postDocument, UA } from './post.mjs';

/** A real HTTP server that answers each request with the next status. */
async function store(statuses) {
	const seen = [];
	const server = createServer((req, res) => {
		const chunks = [];
		req.on('data', (c) => chunks.push(c));
		req.on('end', () => {
			seen.push({ headers: req.headers, body: Buffer.concat(chunks) });
			const status = statuses[Math.min(seen.length - 1, statuses.length - 1)];
			res.writeHead(status, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ status }));
		});
	});
	await new Promise((r) => server.listen(0, '127.0.0.1', r));
	const url = `http://127.0.0.1:${server.address().port}/health/api/tests/runs`;
	return { url, seen, close: () => new Promise((r) => server.close(r)) };
}

const DOC = { schema: 1, repo: 'WolffM/x', suite: 's', tests: [{ test_name: 't' }] };

test('posts the document gzipped, with the key and a real User-Agent', async () => {
	const s = await store([200]);
	const r = await postDocument({ doc: DOC, key: 'k1', endpoint: s.url, retryDelayMs: 0 });
	await s.close();
	assert.equal(r.ok, true);
	assert.equal(s.seen.length, 1);
	const { headers, body } = s.seen[0];
	assert.equal(headers['content-encoding'], 'gzip');
	assert.equal(headers['x-user-key'], 'k1');
	assert.equal(headers['user-agent'], UA);
	assert.deepEqual(JSON.parse(gunzipSync(body).toString()), DOC);
});

test('a 5xx is retried once, then succeeds', async () => {
	const s = await store([503, 200]);
	const r = await postDocument({ doc: DOC, key: 'k', endpoint: s.url, retryDelayMs: 0 });
	await s.close();
	assert.equal(r.ok, true);
	assert.equal(s.seen.length, 2);
});

test('a 4xx is not retried, and is reported with the store’s reason', async () => {
	const s = await store([400]);
	const r = await postDocument({ doc: DOC, key: 'k', endpoint: s.url, retryDelayMs: 0 });
	await s.close();
	assert.equal(r.ok, false);
	assert.equal(s.seen.length, 1);
	assert.match(r.message, /HTTP 400/);
});

test('no key posts nothing', async () => {
	const s = await store([200]);
	const r = await postDocument({ doc: DOC, key: '', endpoint: s.url });
	await s.close();
	assert.equal(r.ok, false);
	assert.equal(s.seen.length, 0);
	assert.match(r.message, /no service key/);
});

test('an unreachable store is a message, not a throw', async () => {
	const s = await store([200]);
	await s.close();
	const r = await postDocument({ doc: DOC, key: 'k', endpoint: s.url, retryDelayMs: 0 });
	assert.equal(r.ok, false);
	assert.match(r.message, /could not be reached/);
});
