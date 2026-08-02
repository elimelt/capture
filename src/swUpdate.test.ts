import { describe, expect, it, vi } from 'vitest'
import { createSwUpdateStore } from './swUpdate'

describe('createSwUpdateStore', () => {
  it('starts with no update available', () => {
    const store = createSwUpdateStore()
    expect(store.snapshot()).toBe(false)
  })

  it('publish flips the snapshot and notifies subscribers', () => {
    const store = createSwUpdateStore()
    const listener = vi.fn()
    store.subscribe(listener)
    store.publish(() => {})
    expect(store.snapshot()).toBe(true)
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('a second publish is idempotent: no re-notify, but the apply fn updates', () => {
    const store = createSwUpdateStore()
    const listener = vi.fn()
    const firstApply = vi.fn()
    const secondApply = vi.fn()
    store.publish(firstApply)
    store.subscribe(listener)
    store.publish(secondApply)
    expect(listener).not.toHaveBeenCalled()
    store.apply()
    expect(firstApply).not.toHaveBeenCalled()
    expect(secondApply).toHaveBeenCalledTimes(1)
  })

  it('apply is a no-op when nothing was ever published', () => {
    const store = createSwUpdateStore()
    expect(() => store.apply()).not.toThrow()
  })

  it('unsubscribe stops further notifications', () => {
    const store = createSwUpdateStore()
    const listener = vi.fn()
    const unsubscribe = store.subscribe(listener)
    unsubscribe()
    store.publish(() => {})
    expect(listener).not.toHaveBeenCalled()
  })
})
