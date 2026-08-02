/**
 * Design tokens — the single place visual identity lives. Components in
 * src/ui/ compose these; screens never hardcode palette classes. A future
 * design pass edits this file (and the primitives), not the screens.
 */

export const tone = {
  /** App background. */
  bg: 'bg-slate-50 dark:bg-slate-950',
  /** Raised surfaces: cards, sheets, nav. */
  surface: 'bg-white dark:bg-slate-900',
  /** Sunken/inset surfaces: inputs, wells. */
  sunken: 'bg-slate-100 dark:bg-slate-800',
  /** Hairline borders on surfaces. */
  border: 'border-slate-200 dark:border-slate-800',
  /** Stronger borders: inputs, secondary buttons. */
  borderStrong: 'border-slate-300 dark:border-slate-700',

  textPrimary: 'text-slate-900 dark:text-slate-100',
  textSecondary: 'text-slate-600 dark:text-slate-300',
  textMuted: 'text-slate-500 dark:text-slate-400',
  textFaint: 'text-slate-400 dark:text-slate-500',

  accent: 'text-sky-600 dark:text-sky-400',
  accentBg: 'bg-sky-600',
  accentBgActive: 'active:bg-sky-700',

  danger: 'text-red-600 dark:text-red-400',
  dangerBg: 'bg-red-600',
  dangerBgActive: 'active:bg-red-700',

  /** Pressed-state wash for bordered/ghost controls. */
  pressWash: 'active:bg-slate-100 dark:active:bg-slate-800',
} as const

export const shape = {
  card: 'rounded-2xl',
  control: 'rounded-xl',
  pill: 'rounded-full',
} as const

export const type_ = {
  /** Screen titles. */
  title: 'text-lg font-semibold tracking-tight',
  /** Section headings. */
  heading: 'text-sm font-semibold',
  /** Primary content. */
  body: 'text-[15px] leading-snug',
  /** Secondary content. */
  sub: 'text-[13px] leading-snug',
  /** Labels, badges, metadata. */
  caption: 'text-xs',
  /** Tiny uppercase section labels. */
  overline: 'text-[11px] font-medium uppercase tracking-wider',
} as const

/** Minimum tap target (Apple HIG 44pt). */
export const tap = 'min-h-11 min-w-11'

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ')
}
