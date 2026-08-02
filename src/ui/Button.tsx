import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { cx, shape, tap, tone, type_ } from './tokens'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'dangerGhost'
export type ButtonSize = 'md' | 'sm'

const VARIANT: Record<ButtonVariant, string> = {
  primary: cx(tone.accentBg, tone.accentBgActive, 'text-white font-medium'),
  secondary: cx(
    'border',
    tone.borderStrong,
    tone.textSecondary,
    tone.pressWash,
    'font-medium',
  ),
  ghost: cx(tone.textSecondary, tone.pressWash, 'font-medium'),
  danger: cx(tone.dangerBg, tone.dangerBgActive, 'text-white font-medium'),
  dangerGhost: cx(
    tone.danger,
    'font-medium active:bg-clay-wash dark:active:bg-clay-wash-dark',
  ),
}

const SIZE: Record<ButtonSize, string> = {
  md: cx(tap, 'px-4', type_.ui),
  sm: cx('min-h-9 px-3', type_.sub),
}

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  /** Stretch to fill the row. */
  block?: boolean
  children: ReactNode
}

export function Button({
  variant = 'secondary',
  size = 'md',
  block = false,
  className,
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      {...rest}
      className={cx(
        'inline-flex items-center justify-center gap-1.5 transition-colors disabled:opacity-40',
        shape.control,
        VARIANT[variant],
        SIZE[size],
        block && 'w-full',
        className,
      )}
    >
      {children}
    </button>
  )
}

export type IconButtonVariant = 'outline' | 'ghost' | 'accent' | 'danger'

const ICON_VARIANT: Record<IconButtonVariant, string> = {
  outline: cx('border', tone.borderStrong, tone.textSecondary, tone.pressWash),
  ghost: cx(tone.textSecondary, tone.pressWash),
  /** Accent-washed fill + border for controls that must read as interactive
   *  against the card surface (e.g. an entry's play button). */
  accent: cx(
    'border',
    tone.borderStrong,
    tone.accentWash,
    tone.accent,
    'active:bg-spruce/15 dark:active:bg-spruce-dark/20',
  ),
  /** Destructive icon actions — muted clay, wash on press. */
  danger: cx(tone.danger, 'active:bg-clay-wash dark:active:bg-clay-wash-dark'),
}

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Required: icon-only buttons must still be accessible. */
  'aria-label': string
  variant?: IconButtonVariant
  children: ReactNode
}

export function IconButton({
  variant = 'outline',
  className,
  children,
  ...rest
}: IconButtonProps) {
  return (
    <button
      {...rest}
      className={cx(
        'inline-flex h-11 w-11 shrink-0 items-center justify-center transition-colors disabled:opacity-40',
        shape.pill,
        ICON_VARIANT[variant],
        className,
      )}
    >
      {children}
    </button>
  )
}
