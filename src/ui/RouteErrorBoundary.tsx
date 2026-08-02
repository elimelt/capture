import { Component, type ReactNode } from 'react'
import { Button } from './Button'
import { cx, tone, type_ } from './tokens'

interface RouteErrorBoundaryProps {
  children: ReactNode
  title: string
  body: string
  /**
   * Called when the user taps Retry. React.lazy caches a rejected `import()`
   * forever on its module-level reference, so a real retry needs a fresh
   * lazy() call, not just clearing this boundary's error — callers should
   * bump a `key` on this component (forcing a full remount, including a
   * freshly memoized lazy component) from this callback.
   */
  onRetry: () => void
}

interface RouteErrorBoundaryState {
  error: Error | null
}

/**
 * A route-scoped sibling of `ErrorBoundary` (issue #66): catches a render
 * error — most commonly a lazy route chunk's `import()` rejecting offline —
 * without taking down the whole app shell. Placed around one route's
 * element so a failure there degrades to an inline message plus a Retry
 * affordance, leaving the tab bar and every other screen usable.
 */
export class RouteErrorBoundary extends Component<
  RouteErrorBoundaryProps,
  RouteErrorBoundaryState
> {
  state: RouteErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): RouteErrorBoundaryState {
    return { error }
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <div
        className={cx(
          'flex min-h-[60vh] flex-col items-center justify-center gap-3 p-6 text-center',
          tone.textPrimary,
        )}
      >
        <h2 className={type_.title}>{this.props.title}</h2>
        <p className={cx(type_.sub, tone.textMuted)}>{this.props.body}</p>
        <Button variant="primary" onClick={this.props.onRetry}>
          Retry
        </Button>
      </div>
    )
  }
}
