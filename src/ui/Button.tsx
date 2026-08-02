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
  dangerGhost: cx(tone.danger, 'font-medium active:bg-red-50 dark:active:bg-red-950'),
}

const SIZE: Record<ButtonSize, string> = {
  md: cx(tap, 'px-4', type_.body),
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

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Required: icon-only buttons must still be accessible. */
  'aria-label': string
  variant?: 'outline' | 'ghost'
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
        variant === 'outline' && cx('border', tone.borderStrong),
        tone.textSecondary,
        tone.pressWash,
        className,
      )}
    >
      {children}
    </button>
  )
}
