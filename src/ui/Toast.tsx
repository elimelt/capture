import { useState, type ReactNode } from 'react'
import { cx, layer, motion, shape, type_ } from './tokens'

interface ToastProps {
  children: ReactNode
  actionLabel?: string
  onAction?: () => void
  /**
   * Clearance above the tab bar, in rem. Default clears it with a small
   * gutter; callers that may render alongside another Toast (e.g. an
   * update-available prompt next to the error toast) bump this so the two
   * stack instead of overlapping.
   */
  bottomRem?: number
}

/**
 * Transient bottom toast with an optional action (undo etc.). The message
 * starts clipped to one line but is tappable to expand in place — long
 * messages (e.g. a sync error) were otherwise silently cut off for the
 * entire 6 s the toast is on screen (issue #67).
 */
export function Toast({ children, actionLabel, onAction, bottomRem = 5.5 }: ToastProps) {
  const [expanded, setExpanded] = useState(false)
  return (
    <div
      className={cx(
        'fixed inset-x-4 mx-auto flex max-w-md items-start justify-between gap-3',
        layer.raised,
        shape.control,
        'border border-transparent bg-ink px-4 py-3 text-paper shadow-lg',
        'dark:border-line-dark dark:bg-card-dark dark:text-ink-dark',
        type_.ui,
        motion.toastIn,
      )}
      style={{ bottom: `calc(env(safe-area-inset-bottom) + ${bottomRem}rem)` }}
      role="status"
    >
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        aria-expanded={expanded}
        className={cx('min-w-0 flex-1 text-left', expanded ? 'whitespace-pre-wrap' : 'truncate')}
      >
        {children}
      </button>
      {actionLabel && onAction && (
        <button
          onClick={onAction}
          className="min-h-11 shrink-0 px-2 font-semibold text-spruce-dark"
        >
          {actionLabel}
        </button>
      )}
    </div>
  )
}
