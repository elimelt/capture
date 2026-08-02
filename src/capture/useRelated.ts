/**
 * Async glue for #83's relatedness scorer: loads each candidate entry's text
 * attachments from IndexedDB, tokenizes them, and calls the pure
 * `relatedEntries`. Kept out of `related.ts` on purpose — that module stays
 * I/O-free and directly unit-testable.
 *
 * Cost bound (#83 req. 5): `enabled` gates all work behind card expansion —
 * an unexpanded card computes nothing, so this never runs for a whole feed.
 * `tokenCache` memoizes tokenized text per entry id for the session (module
 * scope, not persisted), so re-expanding a card or a card that appears as
 * both a target and a candidate elsewhere never re-reads or re-tokenizes the
 * same blobs.
 */
import { useEffect, useState } from 'react'
import type { Entry } from '../contract/types'
import { getBlob } from '../store/events'
import { groupAttachments } from './attachmentGroups'
import { cardViewModel } from './cardView'
import {
  type RelatedCandidate,
  type RelatedResult,
  firstLine,
  relatedEntries,
  tokenizeEntryText,
} from './related'

/** entry id -> tokenized content words, memoized for the session. */
const tokenCache = new Map<string, Set<string>>()

async function entryTexts(entry: Entry): Promise<string[]> {
  const texts: string[] = []
  for (const a of entry.attachments) {
    if (a.kind !== 'text') continue
    const blob = await getBlob(a.file)
    const text = (await blob?.text())?.trim()
    if (text) texts.push(text)
  }
  return texts
}

async function tokensFor(entry: Entry): Promise<Set<string>> {
  const cached = tokenCache.get(entry.id)
  if (cached) return cached
  const tokens = tokenizeEntryText(await entryTexts(entry))
  tokenCache.set(entry.id, tokens)
  return tokens
}

/** One-line preview of a candidate's primary content for the related row. */
async function snippetFor(entry: Entry): Promise<string> {
  const vm = cardViewModel(entry, groupAttachments(entry.attachments))
  if (vm.primaryText) {
    const blob = await getBlob(vm.primaryText.file)
    const text = (await blob?.text())?.trim()
    if (text) return firstLine(text)
  }
  if (vm.primaryAudio) return 'Voice note'
  if (entry.attachments.some((a) => a.kind === 'photo')) return 'Photo'
  return ''
}

export interface RelatedRow extends RelatedResult {
  entry: Entry
  snippet: string
}

/**
 * Related memories for `target` among `candidates` (typically the whole
 * folded log — `useAppStore((s) => s.entries)` — relatedness can span any
 * date, not just the entries a screen happens to be showing). Does nothing
 * until `enabled` (the expanded state) flips true.
 */
export function useRelated(
  target: Entry,
  candidates: readonly Entry[],
  enabled: boolean,
): RelatedRow[] {
  const [rows, setRows] = useState<RelatedRow[]>([])

  useEffect(() => {
    if (!enabled) {
      setRows([])
      return
    }
    let stale = false
    void (async () => {
      const targetTokens = await tokensFor(target)
      const live = candidates.filter((c) => c.id !== target.id && !c.revoked)
      const byId = new Map(live.map((c) => [c.id, c]))
      const scoredCandidates: RelatedCandidate[] = await Promise.all(
        live.map(async (c) => ({
          id: c.id,
          capturedAt: c.capturedAt,
          placeLabel: c.location?.placeLabel,
          tokens: await tokensFor(c),
        })),
      )
      const results = relatedEntries(
        {
          id: target.id,
          capturedAt: target.capturedAt,
          placeLabel: target.location?.placeLabel,
          tokens: targetTokens,
        },
        scoredCandidates,
      )
      if (stale || results.length === 0) {
        if (!stale) setRows([])
        return
      }
      const withSnippets = await Promise.all(
        results.map(async (r) => {
          const entry = byId.get(r.entryId)
          if (!entry) return null
          return { ...r, entry, snippet: await snippetFor(entry) }
        }),
      )
      if (!stale) setRows(withSnippets.filter((r): r is RelatedRow => r !== null))
    })()
    return () => {
      stale = true
    }
  }, [target, candidates, enabled])

  return rows
}
