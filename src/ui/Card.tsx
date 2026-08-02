import type { ReactNode } from 'react'
import { cx, shape, tone, type_ } from './tokens'

export function Card({
  className,
  children,
}: {
  className?: string
  children: ReactNode
}) {
  return (
    <div
      className={cx(
        shape.card,
        'border',
        tone.border,
        tone.surface,
        'p-3 shadow-sm shadow-ink/[0.04] dark:shadow-none',
        className,
      )}
    >
      {children}
    </div>
  )
}

/** Titled settings/content section. */
export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className={cx(shape.card, 'border', tone.border, tone.surface, 'p-4')}>
      <h2 className={cx('mb-3', type_.heading, tone.textPrimary)}>{title}</h2>
      {children}
    </section>
  )
}

export function EmptyState({
  title,
  children,
}: {
  title: string
  children?: ReactNode
}) {
  return (
    <div className="flex flex-col items-center gap-1.5 px-6 py-10 text-center">
      <p className={cx('font-serif text-[16px] italic', tone.textMuted)}>{title}</p>
      {children && <div className={cx(type_.sub, tone.textFaint)}>{children}</div>}
    </div>
  )
}
