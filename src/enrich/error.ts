/**
 * Shared failure taxonomy for the enrichment pipelines (src/transcribe,
 * src/vision). Every error either pipeline's api.ts or the shared runner can
 * throw is classified into exactly one of:
 *
 * - **Retryable** (transient): back off in memory and try again this session
 *   or a later one — network hiccups, 5xx, 408/429, a truncated stream.
 * - **Permanent**: this exact input will never succeed — a 4xx rejection of
 *   the request itself (bad codec, oversized body) or a local decode
 *   failure. The runner skip-marks these instead of retrying forever
 *   (issue #60).
 *
 * A `hostDown` subset of retryable errors (network failure or request
 * timeout — as opposed to a same-request HTTP error) additionally trips the
 * runner's per-drain circuit breaker (issue #62): once one is seen, the rest
 * of that drain's items are left pending rather than each burning its own
 * 60s timeout against a stalled host.
 */

export interface FailureClass {
  retryable: boolean
  hostDown: boolean
}

/** An error an api.ts client throws with a known classification, mirroring
 * `DriveError` (src/drive/client.ts) for the enrichment pipelines. */
export class EnrichmentError extends Error {
  readonly retryable: boolean
  readonly hostDown: boolean
  constructor(message: string, opts: { retryable: boolean; hostDown?: boolean }) {
    super(message)
    this.name = 'EnrichmentError'
    this.retryable = opts.retryable
    this.hostDown = opts.hostDown ?? false
  }
}

/**
 * 408 (request timeout) and 429 (rate limited) and 5xx (server trouble) are
 * transient — the same request may succeed later. Any other 4xx is a
 * permanent rejection of this exact request: it will fail identically on
 * every retry (an unsupported codec, a body over the server's size limit, a
 * malformed request), so retrying only re-uploads the full media for
 * nothing.
 */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500
}

/**
 * Classifies any error thrown by a pipeline's api.ts or by the runner's own
 * blob/decode handling. Errors this taxonomy doesn't recognize default to
 * "retryable, not host-down" — the same "assume transient" behavior the
 * runners always had — so this only ever *adds* permanent/circuit-breaker
 * handling on top of the existing backoff, never removes it.
 */
export function classifyFailure(err: unknown): FailureClass {
  if (err instanceof EnrichmentError) return { retryable: err.retryable, hostDown: err.hostDown }
  // fetch() itself throws these for a stalled/unreachable host, before an
  // api.ts client gets a chance to wrap them: AbortSignal.timeout() firing
  // (a DOMException, name 'TimeoutError' in current browsers, 'AbortError'
  // in older ones) or a network-level failure (TypeError, e.g. "Failed to
  // fetch" / "Load failed").
  if (err instanceof TypeError) return { retryable: true, hostDown: true }
  if (
    typeof DOMException !== 'undefined' &&
    err instanceof DOMException &&
    (err.name === 'AbortError' || err.name === 'TimeoutError')
  ) {
    return { retryable: true, hostDown: true }
  }
  return { retryable: true, hostDown: false }
}

/** Best-effort human-readable reason for a skip marker (issue #55). */
export function describeFailure(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
