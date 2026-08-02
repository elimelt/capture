import { cx, motion, shape, tone } from './tokens'

/**
 * Thin horizontal progress bar. `fraction` is `[0, 1]` for a determinate fill
 * (width transitions smoothly), or `null` for an indeterminate sweep — a
 * phase with no known total (e.g. a Drive pull page count). Deliberately
 * generic (no sync-domain knowledge): callers compute `fraction` themselves,
 * e.g. `syncProgressFraction` (`src/store/syncProgress`).
 */
export function ProgressBar({
  fraction,
  className,
}: {
  fraction: number | null
  className?: string
}) {
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      {...(fraction === null ? {} : { 'aria-valuenow': Math.round(fraction * 100) })}
      className={cx('h-1 w-full overflow-hidden', shape.pill, tone.sunken, className)}
    >
      {fraction === null ? (
        <div className={cx('h-full w-1/3', shape.pill, tone.accentBg, motion.indeterminate)} />
      ) : (
        <div
          className={cx('h-full transition-[width] duration-300 ease-out', shape.pill, tone.accentBg)}
          style={{ width: `${Math.round(Math.min(1, Math.max(0, fraction)) * 100)}%` }}
        />
      )}
    </div>
  )
}
