import { describe, expect, it, vi } from 'vitest'
import { createLiveTextStore } from './livetext'

describe('createLiveTextStore', () => {
  it('starts empty and exposes set text through the snapshot', () => {
    const store = createLiveTextStore()
    expect(store.snapshot().size).toBe(0)
    store.set('a.m4a', 'hello')
    expect(store.snapshot().get('a.m4a')).toBe('hello')
  })

  it('notifies subscribers on set, clear, and sweep', () => {
    const store = createLiveTextStore()
    const listener = vi.fn()
    store.subscribe(listener)

    store.set('a.m4a', 'hi')
    store.set('a.m4a', 'hi there')
    store.clear('a.m4a')
    store.set('b.jpg', 'x')
    store.sweep(new Set())
    expect(listener).toHaveBeenCalledTimes(5)
  })

  it('replaces the snapshot reference on change and keeps it stable otherwise', () => {
    const store = createLiveTextStore()
    const before = store.snapshot()
    store.set('a.m4a', 'hi')
    const after = store.snapshot()
    expect(after).not.toBe(before)
    expect(store.snapshot()).toBe(after)
  })

  it('skips notification when nothing changes', () => {
    const store = createLiveTextStore()
    store.set('a.m4a', 'hi')
    const listener = vi.fn()
    store.subscribe(listener)

    store.set('a.m4a', 'hi') // same text
    store.clear('missing') // absent key
    store.sweep(new Set(['a.m4a'])) // nothing to drop
    expect(listener).not.toHaveBeenCalled()
    expect(store.snapshot().get('a.m4a')).toBe('hi')
  })

  it('sweep keeps only the given files', () => {
    const store = createLiveTextStore()
    store.set('a.m4a', 'one')
    store.set('b.m4a', 'two')
    store.set('c.jpg', 'three')

    store.sweep(new Set(['b.m4a']))
    expect([...store.snapshot().keys()]).toEqual(['b.m4a'])
  })

  it('unsubscribe stops notifications', () => {
    const store = createLiveTextStore()
    const listener = vi.fn()
    const off = store.subscribe(listener)
    off()
    store.set('a.m4a', 'hi')
    expect(listener).not.toHaveBeenCalled()
  })
})
