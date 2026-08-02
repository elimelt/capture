import type { ReactNode } from 'react'
import { cx, tone, type_ } from './tokens'

/** Screen title row; sits below the iOS status bar via App's safe-area pad. */
export function ScreenHeader({
  title,
  subtitle,
  trailing,
}: {
  title: string
  subtitle?: string
  trailing?: ReactNode
}) {
  return (
    <header className="flex items-baseline justify-between gap-3">
      <div className="min-w-0">
        <h1 className={cx(type_.title, tone.textPrimary)}>{title}</h1>
        {subtitle && <p className={cx('mt-0.5', type_.sub, tone.textMuted)}>{subtitle}</p>}
      </div>
      {trailing && <div className="shrink-0">{trailing}</div>}
    </header>
  )
}
