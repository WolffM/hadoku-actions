/**
 * Is a test failure the app's, or the environment's?
 *
 * `classifyError(message)` returns 'infra' when the error says the test never
 * got a fair answer from the code under test: a name that did not resolve, a
 * connection to a REMOTE host that reset or timed out, a Cloudflare block page,
 * a browser that could not launch, a full disk or an exhausted heap. Everything
 * else is 'app', including a connection refused on loopback: in a hermetic suite
 * that is the app's own server not answering.
 *
 * Deliberately narrow. Calling an app bug infra hides it (it reads as "not our
 * code" and nobody looks); calling infra an app bug costs one look. So a pattern
 * belongs here only when it cannot plausibly be the code under test, and the
 * default is 'app'. Dry-run against 30 days of fleet e2e failures before
 * widening it: docs/planning/e2e-evidence-2026-11-23.md in hadoku_site.
 */

const LOOPBACK = /\b(127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\])\b/i;

/** Always infra, wherever they point. */
const ALWAYS = [
	// DNS: the runner could not resolve a name.
	/\b(ENOTFOUND|EAI_AGAIN)\b/,
	/net::ERR_NAME_NOT_RESOLVED/,
	/getaddrinfo .*(ENOTFOUND|EAI_AGAIN)/,
	// Cloudflare refusing the runner, not the app answering.
	/Attention Required! \| Cloudflare/i,
	/Just a moment\.\.\./,
	/\bcf-mitigated\b/i,
	/error code: 10(06|07|08|10|12|15|20)\b/,
	// The browser never started.
	/browserType\.launch/,
	/Executable doesn't exist at/,
	/Host system is missing dependencies to run browsers/,
	// The runner ran out of something.
	/\bENOSPC\b/,
	/No space left on device/,
	/JavaScript heap out of memory/,
	/The runner has received a shutdown signal/,
];

/** Infra only when the error is about a non-loopback host. */
const REMOTE = [
	/\b(ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|EPIPE)\b/,
	/socket hang up/,
	/net::ERR_(CONNECTION_RESET|CONNECTION_TIMED_OUT|CONNECTION_CLOSED|INTERNET_DISCONNECTED|NETWORK_CHANGED|TIMED_OUT|ADDRESS_UNREACHABLE)/,
	/\bUND_ERR_(CONNECT_TIMEOUT|SOCKET|HEADERS_TIMEOUT)\b/,
];

/**
 * @param {string | null | undefined} message
 * @returns {'infra' | 'app'}
 */
export function classifyError(message) {
	if (!message) return 'app';
	if (ALWAYS.some((re) => re.test(message))) return 'infra';
	if (REMOTE.some((re) => re.test(message)) && !LOOPBACK.test(message)) return 'infra';
	return 'app';
}

/**
 * A run's conclusion from its rows (see monitoring-api's E2E_RUN_CLASSES).
 * `harness`: no usable report, no tests, or the runner reported errors outside
 * any test (a crashed globalSetup, a beforeAll that threw). `infra`: every
 * failed test failed for an infra reason. `app`: any other failure, or a skip
 * the allow-list does not cover.
 *
 * @param {{ reportStatus: string, rows: {outcome: string, failure_class?: string | null}[], suiteErrors: string[], unallowedSkips: number }} r
 * @returns {'green' | 'flaky' | 'app' | 'infra' | 'harness'}
 */
export function classifyRun({ reportStatus, rows, suiteErrors, unallowedSkips }) {
	if (reportStatus !== 'ok' || rows.length === 0 || suiteErrors.length > 0) return 'harness';
	const failed = rows.filter((r) => r.outcome === 'failed');
	if (failed.length > 0) {
		return failed.every((r) => r.failure_class === 'infra') ? 'infra' : 'app';
	}
	if (unallowedSkips > 0) return 'app';
	if (rows.some((r) => r.outcome === 'flaky')) return 'flaky';
	return 'green';
}
