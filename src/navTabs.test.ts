import { describe, expect, it } from 'vitest'
import { TABS, visibleTabs } from './navTabs'

describe('TABS', () => {
  it('pins route paths — deep links and the SW precache manifest are', () => {
    // label-independent; a future rename must change labels only. `/chat`
    // is deliberately absent: the assistant is reached from an entry card's
    // "Ask AI" action, never a tab.
    expect(TABS.map((t) => t.to)).toEqual(['/', '/day', '/settings'])
  })

  it('pins the current tab labels (Day→Today rename)', () => {
    expect(TABS.map((t) => t.label)).toEqual(['Capture', 'Today', 'Settings'])
  })

  it('has no assistant-gated tab (the assistant has no tab of its own)', () => {
    expect(TABS.filter((t) => t.assistant)).toEqual([])
  })
})

describe('visibleTabs', () => {
  it('is the identity while no tab is assistant-gated', () => {
    expect(visibleTabs(TABS, false)).toEqual([...TABS])
    expect(visibleTabs(TABS, true)).toEqual([...TABS])
  })

  it('drops assistant-gated tabs when the assistant is disabled', () => {
    const tabs = [...TABS, { to: '/chat', label: 'Recall', assistant: true }]
    expect(visibleTabs(tabs, false).map((t) => t.to)).toEqual(['/', '/day', '/settings'])
    expect(visibleTabs(tabs, true).map((t) => t.to)).toEqual(['/', '/day', '/settings', '/chat'])
  })
})
