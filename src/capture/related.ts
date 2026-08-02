/**
 * Local relatedness scorer (#83) — ranks candidate entries against a target
 * entry using only signals computable from data already on the device:
 * shared `location.placeLabel` (exact match), lexical overlap of the text
 * attachments both entries already carry, and a mild damping of that
 * combined score by how far apart in time the two entries were captured.
 * No I/O, no `Date.now()`/`Math.random()`, no embeddings, no LLM calls — the
 * "age gap" damping compares the two entries' own `capturedAt` fields to
 * each other, never to wall-clock now, so the module needs no `now`
 * argument to stay pure. Unit-tested directly (`related.test.ts`).
 *
 * Honest inventory (see #83): topics, entities, and people are NOT
 * available without new enrichment and are explicitly out of scope here.
 *
 * Future seam (documented, not built): an entity/topic enrichment runner
 * (#51/#62's plan/api/runner pattern) could append per-entry derived
 * `text/json` attachments (`derivedFrom` pointing at the source audio/photo)
 * whose terms feed `tokenizeEntryText`/`relatedEntries` unchanged — the
 * scorer doesn't care whether a token came from a transcript or a future
 * derived-topic attachment. Do not add a third copy-paste runner here.
 */

/** Minimum combined (post-damping) score for a candidate to be surfaced at all. */
export const RELATED_MIN_SCORE = 0.3

/** Most related entries surfaced per target (#83 req. 3: "up to 2"). */
export const RELATED_MAX_RESULTS = 2

/** Tokens shorter than this carry too little signal to count as overlap. */
const MIN_TOKEN_LEN = 3

/** Cap on how many shared terms a result reports (UI only needs one or two). */
const SHARED_TERMS_MAX = 5

// Common English function words: they occur in nearly every entry and would
// otherwise dominate the overlap coefficient with no topical signal.
const STOPWORDS = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'any', 'can', 'her',
  'was', 'one', 'our', 'out', 'day', 'get', 'has', 'had', 'him', 'his', 'how',
  'man', 'new', 'now', 'old', 'see', 'two', 'way', 'who', 'boy', 'did', 'its',
  'let', 'put', 'say', 'she', 'too', 'use', 'that', 'with', 'have', 'this',
  'from', 'they', 'will', 'would', 'there', 'their', 'what', 'about', 'which',
  'when', 'make', 'like', 'time', 'just', 'know', 'take', 'into', 'your',
  'good', 'some', 'could', 'them', 'than', 'then', 'been', 'were', 'said',
  'each', 'because', 'does', 'doing', 'over', 'again', 'here', 'more', 'most',
  'other', 'such', 'only', 'own', 'same', 'very', 'also', 'went', 'going',
  'today', 'still', 'while', 'after', 'before', 'being', 'off', 'through',
  'these', 'those', 'i', 'im', 'ive', 'me', 'we', 'us', 'a', 'an', 'is', 'it',
  'in', 'on', 'at', 'to', 'of', 'or', 'be', 'as', 'so', 'do', 'no', 'up',
])

/** Case-fold + strip punctuation, drop stopwords and very short tokens. */
export function tokenizeEntryText(texts: string[]): Set<string> {
  const tokens = new Set<string>()
  for (const text of texts) {
    for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
      if (raw.length < MIN_TOKEN_LEN) continue
      if (STOPWORDS.has(raw)) continue
      tokens.add(raw)
    }
  }
  return tokens
}

export type RelatedReason = 'place' | 'words'

export interface RelatedResult {
  entryId: string
  score: number
  reasons: RelatedReason[]
  /** Overlapping content words, sorted, capped at SHARED_TERMS_MAX; only when 'words' fires. */
  sharedTerms?: string[]
}

/** Minimal shape the scorer needs from the entry being viewed. */
export interface RelatedTarget {
  id: string
  /** ISO-8601 with local offset (Entry.capturedAt). */
  capturedAt: string
  placeLabel?: string
  tokens: Set<string>
}

/** Minimal shape the scorer needs from each candidate; revoked ones are always excluded. */
export interface RelatedCandidate extends RelatedTarget {
  revoked?: boolean
}

export interface RelatedOptions {
  minScore?: number
  maxResults?: number
}

const PLACE_SCORE = 0.6
/** Max contribution from lexical overlap alone — kept below PLACE_SCORE so an
 *  exact place match always outranks a lexical-only match (pinned invariant). */
const WORDS_MAX = 0.5

// Recency damping: a gentle decay by day-gap between the two entries' own
// capturedAt fields (never wall-clock "now" — this module takes no `now`
// argument). The floor keeps a strong six-month-old match well clear of
// RELATED_MIN_SCORE, per the design review's explicit "six months ago" ask.
const RECENCY_HALFLIFE_DAYS = 90
const RECENCY_FLOOR = 0.6

function overlapCoefficient(a: ReadonlySet<string>, b: ReadonlySet<string>): {
  coeff: number
  shared: string[]
} {
  if (a.size === 0 || b.size === 0) return { coeff: 0, shared: [] }
  const [small, large] = a.size <= b.size ? [a, b] : [b, a]
  const shared: string[] = []
  for (const t of small) if (large.has(t)) shared.push(t)
  return { coeff: shared.length / small.size, shared: shared.sort() }
}

function daysBetween(isoA: string, isoB: string): number {
  const ms = Math.abs(new Date(isoA).getTime() - new Date(isoB).getTime())
  return ms / (24 * 60 * 60 * 1000)
}

function recencyFactor(days: number): number {
  return RECENCY_FLOOR + (1 - RECENCY_FLOOR) * (RECENCY_HALFLIFE_DAYS / (RECENCY_HALFLIFE_DAYS + days))
}

/**
 * Ranks `candidates` against `target`. Always excludes the target itself and
 * any revoked candidate; always gates on `opts.minScore` (default
 * `RELATED_MIN_SCORE`) and caps at `opts.maxResults` (default
 * `RELATED_MAX_RESULTS`). Deterministic: ties break by smaller day-gap, then
 * by entry id, so identical inputs always produce the same ordered output.
 */
export function relatedEntries(
  target: RelatedTarget,
  candidates: readonly RelatedCandidate[],
  opts?: RelatedOptions,
): RelatedResult[] {
  const minScore = opts?.minScore ?? RELATED_MIN_SCORE
  const maxResults = opts?.maxResults ?? RELATED_MAX_RESULTS

  const scored: Array<RelatedResult & { days: number }> = []
  for (const c of candidates) {
    if (c.id === target.id || c.revoked) continue

    const reasons: RelatedReason[] = []
    let raw = 0
    let sharedTerms: string[] | undefined

    if (target.placeLabel && c.placeLabel && target.placeLabel === c.placeLabel) {
      reasons.push('place')
      raw += PLACE_SCORE
    }

    const { coeff, shared } = overlapCoefficient(target.tokens, c.tokens)
    if (coeff > 0) {
      reasons.push('words')
      raw += WORDS_MAX * coeff
      sharedTerms = shared.slice(0, SHARED_TERMS_MAX)
    }

    if (raw <= 0) continue

    const days = daysBetween(target.capturedAt, c.capturedAt)
    const score = Math.min(1, raw) * recencyFactor(days)
    if (score < minScore) continue

    scored.push({ entryId: c.id, score, reasons, sharedTerms, days })
  }

  scored.sort((a, b) => b.score - a.score || a.days - b.days || (a.entryId < b.entryId ? -1 : 1))

  return scored
    .slice(0, maxResults)
    .map((r) => ({ entryId: r.entryId, score: r.score, reasons: r.reasons, sharedTerms: r.sharedTerms }))
}

/** Truncates to the first line, collapsing internal whitespace, with an ellipsis past `maxLen`. */
export function firstLine(text: string, maxLen = 80): string {
  const line = text.split('\n', 1)[0]!.trim()
  return line.length > maxLen ? `${line.slice(0, maxLen - 1).trimEnd()}…` : line
}

/**
 * Relative day label for a related row ("Today", "Yesterday", "3 days ago",
 * "6 months ago", "1 year ago today"). Pure: `today` ("YYYY-MM-DD") is
 * supplied by the caller (`localDateOf(toLocalIso(new Date()))`) rather than
 * computed here, so this stays a deterministic function of its inputs.
 */
export function relativeDayLabel(iso: string, today: string): string {
  const date = iso.slice(0, 10)
  if (date === today) return 'Today'

  const days = Math.round(daysBetween(`${date}T12:00:00`, `${today}T12:00:00`))
  if (days === 1) return 'Yesterday'
  if (days < 7) return `${days} days ago`
  if (days < 31) {
    const weeks = Math.max(1, Math.round(days / 7))
    return weeks === 1 ? '1 week ago' : `${weeks} weeks ago`
  }
  if (days < 365) {
    const months = Math.max(1, Math.round(days / 30))
    return months === 1 ? '1 month ago' : `${months} months ago`
  }
  const years = Math.max(1, Math.round(days / 365))
  const sameCivilDay = date.slice(5) === today.slice(5) // "MM-DD"
  const suffix = sameCivilDay ? ' today' : ''
  return years === 1 ? `1 year ago${suffix}` : `${years} years ago${suffix}`
}

/**
 * Human-readable "why" for a related row (#83 req. 2), e.g. "Also at Office"
 * or 'You've mentioned "ci flow" before' — joined when both fire.
 */
export function reasonLabel(
  reasons: readonly RelatedReason[],
  opts: { placeLabel?: string; sharedTerms?: readonly string[] },
): string {
  const parts: string[] = []
  if (reasons.includes('place') && opts.placeLabel) parts.push(`Also at ${opts.placeLabel}`)
  if (reasons.includes('words') && opts.sharedTerms && opts.sharedTerms.length > 0) {
    parts.push(`You've mentioned "${opts.sharedTerms[0]}" before`)
  }
  return parts.join(' · ')
}
