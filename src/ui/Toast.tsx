import type { ReactNode } from 'react'
import { cx, shape, type_ } from './tokens'

interface ToastProps {
  children: ReactNode
  actionLabel?: string
  onAction?: () => void
}

/** Transient bottom toast with an optional action (undo etc.). */
export function Toast({ children, actionLabel, onAction }: ToastProps) {
  return (
    <div
      className={cx(
        'fixed inset-x-4 z-40 mx-auto flex max-w-md items-center justify-between gap-3',
        shape.control,
        'bg-slate-900 px-4 py-3 text-white shadow-lg dark:bg-slate-700',
        type_.body,
      )}
      style={{ bottom: 'calc(env(safe-area-inset-bottom) + 5.5rem)' }}
      role="status"
    >
      <span className="min-w-0 truncate">{children}</span>
      {actionLabel && onAction && (
        <button
          onClick={onAction}
          className="min-h-11 shrink-0 px-2 font-semibold text-sky-300"
        >
          {actionLabel}
        </button>
      )}
    </div>
  )
}
