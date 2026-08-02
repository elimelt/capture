import { Component, type ReactNode } from 'react'
import { Button } from './Button'
import { cx, tone, type_ } from './tokens'

interface ErrorBoundaryProps {
  children: ReactNode
}

interface ErrorBoundaryState {
  error: Error | null
}

/** Catches render errors (class components are the only way) with a reload fallback. */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error }
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <div
        className={cx(
          'flex min-h-dvh flex-col items-center justify-center gap-4 p-6 text-center',
          tone.bg,
          tone.textPrimary,
        )}
      >
        <h1 className={type_.title}>Something went wrong</h1>
        <p className={cx(type_.sub, tone.textMuted)}>{this.state.error.message}</p>
        <Button variant="primary" onClick={() => location.reload()}>
          Reload
        </Button>
      </div>
    )
  }
}
