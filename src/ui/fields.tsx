import type { InputHTMLAttributes, TextareaHTMLAttributes } from 'react'
import { cx, shape, tap, tone, type_ } from './tokens'

const FIELD = cx(
  shape.control,
  'border font-sans',
  tone.borderStrong,
  tone.surface,
  tone.textPrimary,
  'outline-none focus:border-spruce dark:focus:border-spruce-dark',
)

export function TextInput({
  className,
  ...rest
}: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input {...rest} className={cx(FIELD, tap, 'px-3', type_.ui, className)} />
  )
}

export function TextArea({
  className,
  ...rest
}: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea {...rest} className={cx(FIELD, 'w-full p-3 text-base', className)} />
  )
}

interface ToggleProps {
  checked: boolean
  onChange: (v: boolean) => void
  label: string
}

export function Toggle({ checked, onChange, label }: ToggleProps) {
  return (
    <label
      className={cx(
        'flex min-h-11 items-center justify-between gap-3',
        type_.ui,
        tone.textSecondary,
      )}
    >
      {label}
      <button
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={cx(
          'relative h-7 w-12 shrink-0 rounded-full transition-colors',
          checked ? tone.accentBg : 'bg-line-strong dark:bg-line-strong-dark',
        )}
      >
        <span
          className={cx(
            'absolute top-1 h-5 w-5 rounded-full bg-white shadow-sm transition-all',
            checked ? 'left-6' : 'left-1',
          )}
        />
      </button>
    </label>
  )
}

/** Row with a trailing control (input, value, etc.). */
export function FieldRow({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <label
      className={cx(
        'flex min-h-11 items-center justify-between gap-3',
        type_.ui,
        tone.textSecondary,
      )}
    >
      {label}
      {children}
    </label>
  )
}
