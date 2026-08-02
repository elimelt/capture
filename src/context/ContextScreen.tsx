/** Context export screen — copy a selected period as portable Markdown. */
import { useEffect, useMemo, useState } from 'react'
import { localDateOf, toLocalIso } from '../contract/time'
import type { Entry } from '../contract/types'
import { useAppStore } from '../store/appStore'
import { getBlob } from '../store/events'
import { Button, Card, EmptyState, ScreenHeader, Toast, cx, motion, shape, tap, tone, type_ } from '../ui'
import { formatContext, type ContextItem } from './export'

type Preset = 'today' | 'yesterday' | 'week' | 'last7'

function shiftDate(date: string, days: number): string {
  const next = new Date(`${date}T12:00:00`)
  next.setDate(next.getDate() + days)
  return localDateOf(toLocalIso(next))
}

function dateRange(preset: Preset, today: string): [string, string] {
  if (preset === 'today') return [today, today]
  if (preset === 'yesterday') {
    const yesterday = shiftDate(today, -1)
    return [yesterday, yesterday]
  }
  if (preset === 'week') {
    const day = new Date(`${today}T12:00:00`).getDay()
    return [shiftDate(today, -day), today]
  }
  return [shiftDate(today, -6), today]
}

async function readContextItem(entry: Entry): Promise<ContextItem> {
  const texts: string[] = []
  for (const attachment of entry.attachments) {
    if (attachment.kind !== 'text') continue
    const blob = await getBlob(attachment.file)
    const text = (await blob?.text())?.trim()
    if (text) texts.push(text)
  }
  return {
    capturedAt: entry.capturedAt,
    place: entry.location?.placeLabel ?? (entry.location?.address ? `near ${entry.location.address}` : undefined),
    texts,
    audioCount: entry.attachments.filter((a) => a.kind === 'audio').length,
    photoCount: entry.attachments.filter((a) => a.kind === 'photo').length,
  }
}

async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return
    } catch {
      // Safari can expose the API but reject it in an installed-PWA context;
      // continue to the selection-based fallback below.
    }
  }
  const area = document.createElement('textarea')
  area.value = text
  area.setAttribute('readonly', '')
  area.style.position = 'fixed'
  area.style.opacity = '0'
  document.body.append(area)
  area.select()
  try {
    if (!document.execCommand('copy')) throw new Error('Clipboard unavailable')
  } finally {
    area.remove()
  }
}

export default function ContextScreen() {
  const entries = useAppStore((s) => s.entries)
  const today = localDateOf(toLocalIso(new Date()))
  const [preset, setPreset] = useState<Preset>('last7')
  const [from, setFrom] = useState(() => dateRange('last7', today)[0])
  const [to, setTo] = useState(today)
  const [items, setItems] = useState<ContextItem[]>([])
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'error'>('idle')

  const selectedEntries = useMemo(
    () => entries.filter((entry) => !entry.revoked && localDateOf(entry.capturedAt) >= from && localDateOf(entry.capturedAt) <= to),
    [entries, from, to],
  )
  const markdown = useMemo(() => formatContext(items, from, to), [items, from, to])

  useEffect(() => {
    let stale = false
    setItems([])
    void Promise.all(selectedEntries.map(readContextItem)).then((next) => {
      if (!stale) setItems(next)
    })
    return () => {
      stale = true
    }
  }, [selectedEntries])

  function applyPreset(next: Preset) {
    const [nextFrom, nextTo] = dateRange(next, today)
    setPreset(next)
    setFrom(nextFrom)
    setTo(nextTo)
    setCopyState('idle')
  }

  async function handleCopy() {
    try {
      await copyText(markdown)
      setCopyState('copied')
    } catch {
      setCopyState('error')
    }
  }

  return (
    <div className={cx('flex flex-col gap-4 p-4', motion.fadeIn)}>
      <ScreenHeader title="Context" subtitle="Take your log anywhere" />

      <Card className="flex flex-col gap-4">
        <div>
          <p className={cx(type_.overline, tone.textMuted)}>Time period</p>
          <div className="mt-2 grid grid-cols-4 gap-1.5">
            {(['today', 'yesterday', 'week', 'last7'] as const).map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => applyPreset(value)}
                className={cx(
                  'min-h-10 px-2 text-center transition-colors',
                  shape.control,
                  type_.caption,
                  preset === value ? cx(tone.accentWash, tone.accent, 'font-semibold') : cx(tone.sunken, tone.textSecondary, tone.pressWash),
                )}
              >
                {{ today: 'Today', yesterday: 'Yesterday', week: 'This week', last7: 'Last 7 days' }[value]}
              </button>
            ))}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <label className={cx(type_.caption, tone.textMuted)}>
            From
            <input className={cx('mt-1 w-full', tone.surface, tone.textPrimary, type_.ui, tap, shape.control, 'border px-3', tone.borderStrong)} type="date" value={from} max={to} onChange={(e) => { setPreset('last7'); setFrom(e.target.value); setCopyState('idle') }} />
          </label>
          <label className={cx(type_.caption, tone.textMuted)}>
            To
            <input className={cx('mt-1 w-full', tone.surface, tone.textPrimary, type_.ui, tap, shape.control, 'border px-3', tone.borderStrong)} type="date" value={to} min={from} max={today} onChange={(e) => { setPreset('last7'); setTo(e.target.value); setCopyState('idle') }} />
          </label>
        </div>
        <Button variant="primary" block onClick={() => void handleCopy()}>
          {copyState === 'copied' ? 'Copied to clipboard' : 'Copy context'}
        </Button>
      </Card>

      <div className="flex items-baseline justify-between px-1">
        <h2 className={cx(type_.heading, tone.textPrimary)}>Preview</h2>
        <span className={cx(type_.caption, tone.textMuted)}>{selectedEntries.length} {selectedEntries.length === 1 ? 'entry' : 'entries'}</span>
      </div>
      {selectedEntries.length === 0 ? (
        <EmptyState title="No entries in this period" />
      ) : (
        <Card className={cx('p-4', motion.riseIn)}>
          <pre className={cx('whitespace-pre-wrap break-words', tone.textSecondary, type_.sub)}>{markdown}</pre>
        </Card>
      )}
      {copyState === 'error' && <Toast>Couldn’t access the clipboard. Try again.</Toast>}
      {copyState === 'copied' && <Toast>Context copied</Toast>}
    </div>
  )
}
