/**
 * Touch gesture decisions for primary-tab navigation (issue #128).
 *
 * Keep the geometry and target exclusions pure so the navigation behavior can
 * be tested without a browser or a router.
 */

export const SWIPE_MIN_DISTANCE = 64
export const SWIPE_DIRECTION_RATIO = 1.25

export type SwipeDirection = 'left' | 'right'

/** Return a navigation direction only for a deliberate horizontal swipe. */
export function getSwipeDirection(
  startX: number,
  startY: number,
  endX: number,
  endY: number,
): SwipeDirection | null {
  const dx = endX - startX
  const dy = endY - startY
  if (Math.abs(dx) < SWIPE_MIN_DISTANCE || Math.abs(dx) < Math.abs(dy) * SWIPE_DIRECTION_RATIO) {
    return null
  }
  return dx < 0 ? 'left' : 'right'
}

/** Return the neighboring tab path, or null when the swipe has nowhere to go. */
export function adjacentTabPath(
  pathname: string,
  tabs: readonly string[],
  direction: SwipeDirection,
): string | null {
  const index = tabs.findIndex((tab) => (tab === '/' ? pathname === '/' : pathname.startsWith(tab)))
  if (index < 0) return null
  const next = index + (direction === 'left' ? 1 : -1)
  return tabs[next] ?? null
}

/**
 * Keep controls, overlays, maps, and horizontal scrolling content in charge of
 * their own gestures. This is deliberately based on the touch-start target.
 */
export function shouldIgnoreSwipe(target: EventTarget | null, boundary: HTMLElement): boolean {
  if (!(target instanceof Element)) return true
  if (
    target.closest(
      'button, a, input, textarea, select, [contenteditable="true"], [data-swipe-ignore], [role="dialog"], .leaflet-container',
    )
  ) {
    return true
  }

  let element: HTMLElement | null = target instanceof HTMLElement ? target : target.parentElement
  while (element && element !== boundary) {
    if (element.scrollWidth > element.clientWidth + 1) return true
    element = element.parentElement
  }
  return false
}
