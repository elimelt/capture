/**
 * The bottom tab bar's data (App.tsx renders it). Pulled out of App.tsx so
 * the tab set — labels and, more importantly, route paths — can be pinned
 * by a hermetic test without importing the whole app shell (store, drive,
 * notify, lazy screens, …). See issue #84: labels are a rename-only surface
 * ("Day" → "Today"); paths are the SW precache / deep-link contract and must
 * never move with a label. The assistant has no tab: `/chat` still exists as
 * a route but is reached only from an entry card's "Ask AI" action.
 */

export interface NavTab {
  to: string
  label: string
  /** Gated behind the opt-in assistant (`AppSettings.assistantEnabled`). */
  assistant?: boolean
}

export const TABS: readonly NavTab[] = [
  { to: '/', label: 'Capture' },
  { to: '/day', label: 'Today' },
  { to: '/settings', label: 'Settings' },
]

/** Tabs to render given whether the opt-in assistant is enabled. */
export function visibleTabs(tabs: readonly NavTab[], assistantEnabled: boolean): NavTab[] {
  return tabs.filter((t) => !t.assistant || assistantEnabled)
}
