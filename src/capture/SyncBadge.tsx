/**
 * Per-entry sync status badge (SPEC §8.4). Reads from the sync rows the drainer
 * advances. Uploaded entries show nothing — a synced entry needs no chrome; we
 * only surface the states the user might act on (still queued, or errored).
 */
import type { SyncStatus } from '../store/db'
import { cx, tone, type_ } from '../ui'

interface SyncBadgeProps {
  status: SyncStatus | undefined
}

export function SyncBadge({ status }: SyncBadgeProps) {
  if (status === undefined || status === 'uploaded') return null
  const isError = status === 'error'
  return (
    <span
      className={cx('inline-flex items-center gap-1', type_.caption, isError ? tone.danger : tone.textFaint)}
      title={isError ? 'Upload failed — will retry' : 'Waiting to sync to Drive'}
    >
      <span
        aria-hidden
        className={cx(
          'inline-block h-1.5 w-1.5 rounded-full',
          isError ? 'bg-clay dark:bg-clay-dark' : 'bg-ink-faint dark:bg-ink-faint-dark',
        )}
      />
      {isError ? 'Failed' : 'Queued'}
    </span>
  )
}
