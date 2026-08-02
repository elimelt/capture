import type { ReactNode } from 'react'
import { cx, tone, type_ } from './tokens'

/**
 * One node on the shared Day/Capture timeline rail. A fixed-width left gutter
 * carries a vertical connecting line, a dot marking this node, and an optional
 * time label; the entry's own content sits in the right column, horizontally
 * aligned to the dot. Consecutive rows rendered with a small (or zero) list
 * gap read as one continuous rail: the line spans the gutter's full height, so
 * a row's line meets its neighbours', with `first`/`last` trimming the stub
 * above the first dot and below the last dot so the rail starts and ends at a
 * node rather than dangling.
 *
 * A `ui` primitive (not a screen) so both `EntryCard` (src/capture) and
 * `PseudoEntryCard` (src/dayview) compose the identical gutter without either
 * importing the other — the layering rule holds, and the rail's geometry lives
 * in one place. Tokens-only: the line/dot use `tone`, the time uses `type_`.
 */
export function TimelineRow({
  time,
  first = false,
  last = false,
  children,
  className,
}: {
  /** Time label shown in the gutter above the dot (e.g. "9:04 AM"). May be an
   *  interactive element (the entry's tap-to-edit time button). */
  time?: ReactNode
  /** Trim the connecting line above the dot — the first node on the rail. */
  first?: boolean
  /** Trim the connecting line below the dot — the last node on the rail. */
  last?: boolean
  children: ReactNode
  className?: string
}) {
  return (
    <div className={cx('relative flex gap-3', className)}>
      {/* Gutter: the rail line (full-height, absolutely centred on the dot
          column) plus the time label and the dot, stacked. The column is a
          direct flex child so it stretches to the row's full height — the
          line must span it for consecutive rows to read as one rail. */}
      <div className="relative flex w-14 shrink-0 flex-col items-center">
        <span
          aria-hidden="true"
          className={cx(
            'absolute w-px border-l',
            tone.border,
            first ? 'top-[1.75rem]' : 'top-0',
            last ? 'h-0' : 'bottom-0',
          )}
        />
        {time !== undefined && (
          <span className={cx('mb-1 text-center tabular-nums', type_.caption, tone.textMuted)}>
            {time}
          </span>
        )}
        <span
          aria-hidden="true"
          className={cx('relative z-10 h-2 w-2 rounded-full', tone.railDot)}
        />
      </div>
      {/* Content column: everything the node shows, aligned beside the dot. */}
      <div className="min-w-0 flex-1 pb-4">{children}</div>
    </div>
  )
}
