/**
 * Pure prose-prompt assembly for the opt-in daily summary (#82). Takes only
 * the day's digest text (the same `formatDigest` rendering the assistant
 * already uses — transcripts/notes/place labels/media counts, never raw
 * blobs) and a human date label, and returns the two chat messages to send.
 * No I/O, no SDK — the network call itself lives in daySummaryClient.ts, kept
 * separate so this module (and its byte-stability guarantee, load-bearing
 * for the cache key) stays trivially testable.
 */

export interface DaySummaryPrompt {
  system: string
  user: string
}

const SYSTEM_PROMPT = [
  'You write one short recap sentence (at most two) of a single day from a personal activity log, using only the entries digest given by the user.',
  'Plain prose only: no lists, no markdown, no headings, no preamble like "Here is a summary".',
  'Never invent details the digest does not contain. If the digest is thin or repetitive, keep the summary short and general rather than speculating.',
].join(' ')

/**
 * Builds the two messages for the chat-completions call. Pure and
 * byte-stable: the same `(dateLabel, digestText)` pair always produces the
 * exact same strings — callers rely on this for cache-key sanity (the prompt
 * itself is never part of the cache key, but flaky assembly would make
 * regenerated output nondeterministic in tests).
 */
export function buildDaySummaryPrompt(dateLabel: string, digestText: string): DaySummaryPrompt {
  return {
    system: SYSTEM_PROMPT,
    user: `Day: ${dateLabel}\n\nEntries:\n${digestText}`,
  }
}
