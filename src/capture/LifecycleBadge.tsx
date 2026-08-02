/**
 * Per-entry lifecycle badge (#79; formerly SyncBadge). Renders the pure
 * `entryLifecycle` mapping, never raw sync/enrichment state directly, so
 * "Queued" cannot reappear here — `lifecycleLabel('settled')` is `null` for
 * both a still-queued (manual-sync-only) and an already-uploaded entry with
 * nothing pending, and both render no chrome. `'understanding'` is
 * deliberately quiet — muted text, no dot — so it reads as ambient
 * processing rather than infrastructure. `'failed'` is the one state that
 * must never get quieter: same visible danger dot + label as the old
 * SyncBadge's "Failed" state, unchanged semantics.
 */
import type { EntryLifecycle } from './lifecycle'
import { lifecycleLabel } from './lifecycle'
import { cx, tone, type_ } from '../ui'

interface LifecycleBadgeProps {
  lifecycle: EntryLifecycle
}

export function LifecycleBadge({ lifecycle }: LifecycleBadgeProps) {
  const label = lifecycleLabel(lifecycle)
  if (label === null) return null
  const isFailed = lifecycle === 'failed'
  return (
    <span
      className={cx('inline-flex items-center gap-1', type_.caption, isFailed ? tone.danger : tone.textMuted)}
    >
      {isFailed && (
        <span aria-hidden className="inline-block h-1.5 w-1.5 rounded-full bg-clay dark:bg-clay-dark" />
      )}
      {label}
    </span>
  )
}
