import { describe, expect, it } from 'vitest'
import {
  discard,
  initialSendQueue,
  settled,
  steer,
  submit,
  type QueuedMessage,
  type SendQueueState,
} from './sendQueue'

function msg(id: string): QueuedMessage {
  return { id, text: `message ${id}` }
}

/** Runs a transition and asserts the input state was not mutated. */
function frozen(state: SendQueueState): SendQueueState {
  return Object.freeze({ ...state, queue: Object.freeze([...state.queue]) }) as SendQueueState
}

describe('initialSendQueue', () => {
  it('starts idle with an empty queue by default', () => {
    expect(initialSendQueue()).toEqual({ turnInFlight: false, queue: [] })
  })

  it('can seed turnInFlight from a live stream (mount mid-turn)', () => {
    expect(initialSendQueue(true)).toEqual({ turnInFlight: true, queue: [] })
  })
})

describe('submit', () => {
  it('sends immediately when idle and marks the turn in flight', () => {
    const { state, commands } = submit(frozen(initialSendQueue()), msg('a'))
    expect(commands).toEqual([{ type: 'send', message: msg('a') }])
    expect(state).toEqual({ turnInFlight: true, queue: [] })
  })

  it('enqueues instead of sending while a turn is in flight (no double send)', () => {
    const { state, commands } = submit(frozen(initialSendQueue(true)), msg('a'))
    expect(commands).toEqual([])
    expect(state).toEqual({ turnInFlight: true, queue: [msg('a')] })
  })

  it('keeps FIFO order across multiple mid-turn submits', () => {
    let s = initialSendQueue(true)
    for (const id of ['a', 'b', 'c']) s = submit(frozen(s), msg(id)).state
    expect(s.queue.map((m) => m.id)).toEqual(['a', 'b', 'c'])
  })
})

describe('settled', () => {
  it('goes idle with no commands when nothing is queued', () => {
    const { state, commands } = settled(frozen(initialSendQueue(true)))
    expect(commands).toEqual([])
    expect(state).toEqual({ turnInFlight: false, queue: [] })
  })

  it('flushes exactly the queue head and stays in flight', () => {
    let s = initialSendQueue(true)
    s = submit(s, msg('a')).state
    s = submit(s, msg('b')).state
    const { state, commands } = settled(frozen(s))
    expect(commands).toEqual([{ type: 'send', message: msg('a') }])
    expect(state).toEqual({ turnInFlight: true, queue: [msg('b')] })
  })

  it('drains one message per settle, in order', () => {
    let s = initialSendQueue(true)
    for (const id of ['a', 'b', 'c']) s = submit(s, msg(id)).state
    const sent: string[] = []
    // Three turns settle; each flush starts the next turn.
    for (let i = 0; i < 3; i++) {
      const t = settled(frozen(s))
      s = t.state
      expect(t.commands).toHaveLength(1)
      const [c] = t.commands
      if (c.type === 'send') sent.push(c.message.id)
      expect(s.turnInFlight).toBe(true)
    }
    expect(sent).toEqual(['a', 'b', 'c'])
    // The final settle finds an empty queue and goes idle.
    const last = settled(frozen(s))
    expect(last.commands).toEqual([])
    expect(last.state).toEqual({ turnInFlight: false, queue: [] })
  })

  it('a message flushed by settle is never sent again by later settles', () => {
    let s = submit(initialSendQueue(true), msg('a')).state
    const first = settled(frozen(s))
    expect(first.commands).toEqual([{ type: 'send', message: msg('a') }])
    const second = settled(frozen(first.state))
    expect(second.commands).toEqual([])
  })
})

describe('steer', () => {
  it('mid-turn: emits only stop and promotes the message to the head', () => {
    let s = initialSendQueue(true)
    for (const id of ['a', 'b', 'c']) s = submit(s, msg(id)).state
    const { state, commands } = steer(frozen(s), 'b')
    expect(commands).toEqual([{ type: 'stop' }])
    expect(state.turnInFlight).toBe(true)
    expect(state.queue.map((m) => m.id)).toEqual(['b', 'a', 'c'])
  })

  it('the abort settle sends the steered message first; the rest continue in order', () => {
    let s = initialSendQueue(true)
    for (const id of ['a', 'b']) s = submit(s, msg(id)).state
    s = steer(s, 'b').state
    // stop() aborts the stream → status settles → one flush.
    const flush = settled(frozen(s))
    expect(flush.commands).toEqual([{ type: 'send', message: msg('b') }])
    // The steered turn settles later; the original queue continues.
    const next = settled(frozen(flush.state))
    expect(next.commands).toEqual([{ type: 'send', message: msg('a') }])
    expect(settled(next.state).state).toEqual({ turnInFlight: false, queue: [] })
  })

  it('degrades to an immediate send when the turn already settled', () => {
    // Queue filled mid-turn, then the turn settled with the flush effect
    // not yet observed by the tapping user: machine is idle, message queued.
    const s: SendQueueState = { turnInFlight: false, queue: [msg('a'), msg('b')] }
    const { state, commands } = steer(frozen(s), 'a')
    expect(commands).toEqual([{ type: 'send', message: msg('a') }])
    expect(state).toEqual({ turnInFlight: true, queue: [msg('b')] })
  })

  it('is a no-op for an unknown id', () => {
    const s = submit(initialSendQueue(true), msg('a')).state
    const { state, commands } = steer(frozen(s), 'nope')
    expect(commands).toEqual([])
    expect(state).toEqual(s)
  })
})

describe('discard', () => {
  it('removes a queued message without side effects', () => {
    let s = initialSendQueue(true)
    for (const id of ['a', 'b']) s = submit(s, msg(id)).state
    const { state, commands } = discard(frozen(s), 'a')
    expect(commands).toEqual([])
    expect(state.queue.map((m) => m.id)).toEqual(['b'])
    // The next settle flushes what remains.
    expect(settled(state).commands).toEqual([{ type: 'send', message: msg('b') }])
  })

  it('is a no-op for an unknown id', () => {
    const s = submit(initialSendQueue(true), msg('a')).state
    const { state, commands } = discard(frozen(s), 'nope')
    expect(commands).toEqual([])
    expect(state).toEqual(s)
  })
})
