/**
 * Wires the deterministic stat line (always on) to the opt-in daily prose
 * (explicit tap only) for DayScreen (#82).
 *
 * - The stat line is derived synchronously and locally from `entries` every
 *   render (`daySynthesis`) — zero I/O, zero network, always shown.
 * - The prose NEVER auto-fires: mounting/changing day only checks the
 *   IndexedDB cache (synthesisCache.ts) for a row whose `inputHash` still
 *   matches today's entries; a stale or missing row leaves `prose`
 *   undefined and `proseState: 'idle'`, requiring the caller to invoke
 *   `generate()` from an explicit "Generate summary" tap.
 * - `generate()` itself does not check the AI opt-in flag — DayScreen must
 *   not even render the affordance that calls it unless
 *   `appSettings.assistantEnabled` is true (belt-and-suspenders: the guard
 *   also lives here so a future caller can't wire the button up wrong).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Entry } from '../contract/types'
import { buildDayDigest } from './dayDigest'
import { fetchDaySummary } from './daySummaryClient'
import { buildDaySummaryPrompt } from './prosePrompt'
import { daySynthesis, synthesisInputHash, type DaySynthesis } from './synthesis'
import { readDaySynthesisCache, writeDaySynthesisCache } from './synthesisCache'

export type ProseState = 'idle' | 'loading' | 'ready' | 'error'

export interface UseDaySynthesisResult {
  stat: DaySynthesis
  /** Cached or freshly generated prose; undefined until a successful
   *  generation (this session or a prior one, cache-hit). */
  prose?: string
  proseState: ProseState
  /** True only when there is something to summarize and the AI opt-in is
   *  on — DayScreen gates the "Generate summary" affordance on this. */
  canGenerate: boolean
  /** Explicit-tap trigger. No-op if `!canGenerate` or already loading. */
  generate: () => void
}

/** A stable key that only changes when the day's actual content changes,
 * not on every DayScreen re-render (DayScreen recomputes `entries` via
 * filter+sort on every render, so a new array identity is not a content
 * change). */
function entriesKey(entries: readonly Entry[]): string {
  return entries.map((e) => `${e.id}:${e.lastEventSeq}`).join(',')
}

export function useDaySynthesis(
  date: string,
  entries: readonly Entry[],
  dateLabel: string,
  assistantEnabled: boolean,
  model: string,
): UseDaySynthesisResult {
  const stat = useMemo(() => daySynthesis(entries), [entries])
  const [prose, setProse] = useState<string | undefined>(undefined)
  const [proseState, setProseState] = useState<ProseState>('idle')
  const key = entriesKey(entries)
  // Latest entries/date for generate() without re-subscribing the callback
  // on every render (entries is a fresh array each render).
  const latest = useRef({ date, entries, dateLabel, model })
  latest.current = { date, entries, dateLabel, model }

  // Cache-only lookup on day/content change. Never calls the network.
  useEffect(() => {
    let live = true
    setProse(undefined)
    setProseState('idle')
    if (entries.length === 0) return
    void (async () => {
      const { items } = await buildDayDigest(entries)
      if (!live) return
      const texts = entries.map((e, i) => ({
        id: e.id,
        textLength: items[i]?.texts.join('').length ?? 0,
      }))
      const hash = synthesisInputHash(entries, texts)
      const cached = await readDaySynthesisCache(date)
      if (!live) return
      if (cached && cached.inputHash === hash) {
        setProse(cached.prose)
        setProseState('ready')
      }
    })()
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- entriesKey is the content-change signal
  }, [date, key])

  const generate = useCallback(() => {
    const { date, entries, dateLabel, model } = latest.current
    if (entries.length === 0) return
    setProseState('loading')
    void (async () => {
      try {
        const { items, text } = await buildDayDigest(entries)
        const texts = entries.map((e, i) => ({
          id: e.id,
          textLength: items[i]?.texts.join('').length ?? 0,
        }))
        const hash = synthesisInputHash(entries, texts)
        const prompt = buildDaySummaryPrompt(dateLabel, text)
        const result = await fetchDaySummary(prompt, model)
        if (!result) {
          setProseState('error')
          return
        }
        await writeDaySynthesisCache({
          date,
          inputHash: hash,
          prose: result,
          generatedAt: new Date().toISOString(),
        })
        setProse(result)
        setProseState('ready')
      } catch {
        setProseState('error')
      }
    })()
  }, [])

  return {
    stat,
    prose,
    proseState,
    canGenerate: assistantEnabled && entries.length > 0 && proseState !== 'loading',
    generate,
  }
}
