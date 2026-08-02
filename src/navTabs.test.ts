import { describe, expect, it } from 'vitest'
import { TABS, visibleTabs } from './navTabs'

describe('TABS', () => {
  it('pins route paths — deep links, the SW precache manifest, and the lazy', () => {
    // ChatScreen chunk-name coupling (vite.config.ts globIgnores) are all
    // label-independent; a future rename must change labels only.
    expect(TABS.map((t) => t.to)).toEqual(['/', '/day', '/chat', '/settings'])
  })

  it('pins the current tab labels (Day→Today, Chat→Recall renames)', () => {
    expect(TABS.map((t) => t.label)).toEqual(['Capture', 'Today', 'Recall', 'Settings'])
  })

  it('marks exactly the Recall tab as assistant-gated', () => {
    expect(TABS.filter((t) => t.assistant).map((t) => t.to)).toEqual(['/chat'])
  })
})

describe('visibleTabs', () => {
  it('hides the assistant tab when the assistant is disabled', () => {
    expect(visibleTabs(TABS, false).map((t) => t.to)).toEqual(['/', '/day', '/settings'])
  })

  it('shows every tab when the assistant is enabled', () => {
    expect(visibleTabs(TABS, true).map((t) => t.to)).toEqual(TABS.map((t) => t.to))
  })
})
