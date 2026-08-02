import { describe, expect, it } from 'vitest'
import {
  DRAG_PX,
  HOLD_MS,
  IDLE_STATE,
  type GestureCommand,
  type GestureState,
  cancel,
  move,
  press,
  release,
  tick,
} from './holdGesture'

const COMMIT_CLASS: GestureCommand[] = ['commit', 'commitThen:photo', 'commitThen:text', 'discard']

describe('holdGesture', () => {
  describe('tap', () => {
    it('press + release under HOLD_MS, under DRAG_PX yields exactly "tap"', () => {
      let s = press(IDLE_STATE, 0)
      s = move(s, 3, -2) // sub-threshold drift
      const { state, command } = release(s, HOLD_MS - 1)
      expect(command).toBe('tap')
      expect(state).toEqual(IDLE_STATE)
    })

    it('a bare press+release with no move at all is a tap', () => {
      const s = press(IDLE_STATE, 1000)
      const { command } = release(s, 1010)
      expect(command).toBe('tap')
    })
  })

  describe('hold boundary', () => {
    it('release just under HOLD_MS is a tap', () => {
      const s = press(IDLE_STATE, 0)
      expect(release(s, HOLD_MS - 1).command).toBe('tap')
    })

    it('release exactly at HOLD_MS is a commit (boundary is inclusive)', () => {
      const s = press(IDLE_STATE, 0)
      expect(release(s, HOLD_MS).command).toBe('commit')
    })

    it('tick before HOLD_MS keeps the phase at "pressed"', () => {
      const s = press(IDLE_STATE, 0)
      expect(tick(s, HOLD_MS - 1).phase).toBe('pressed')
    })

    it('tick at/after HOLD_MS engages "holding"', () => {
      const s = press(IDLE_STATE, 0)
      expect(tick(s, HOLD_MS).phase).toBe('holding')
    })
  })

  describe('hold then release without drag', () => {
    it('yields "commit"', () => {
      let s = press(IDLE_STATE, 0)
      s = tick(s, HOLD_MS)
      expect(s.phase).toBe('holding')
      const { state, command } = release(s, HOLD_MS + 50)
      expect(command).toBe('commit')
      expect(state).toEqual(IDLE_STATE)
    })
  })

  describe('hold then drag into each zone', () => {
    function held(): GestureState {
      return tick(press(IDLE_STATE, 0), HOLD_MS)
    }

    it('drag left past DRAG_PX yields "commitThen:photo"', () => {
      const s = move(held(), -DRAG_PX, 0)
      expect(s.phase).toBe('dragging')
      expect(s.target).toBe('photo')
      expect(release(s, HOLD_MS + 100).command).toBe('commitThen:photo')
    })

    it('drag right past DRAG_PX yields "commitThen:text"', () => {
      const s = move(held(), DRAG_PX, 0)
      expect(s.target).toBe('text')
      expect(release(s, HOLD_MS + 100).command).toBe('commitThen:text')
    })

    it('drag up past DRAG_PX yields "discard"', () => {
      const s = move(held(), 0, -DRAG_PX)
      expect(s.target).toBe('cancel')
      expect(release(s, HOLD_MS + 100).command).toBe('discard')
    })

    it('drag down past DRAG_PX has no assigned zone and still commits (non-goal: no location zone)', () => {
      const s = move(held(), 0, DRAG_PX)
      expect(s.phase).toBe('holding')
      expect(s.target).toBeUndefined()
      expect(release(s, HOLD_MS + 100).command).toBe('commit')
    })

    it('a drag can retarget live before release (last position wins)', () => {
      let s = held()
      s = move(s, -DRAG_PX, 0)
      expect(s.target).toBe('photo')
      s = move(s, DRAG_PX, 0)
      expect(s.target).toBe('text')
      expect(release(s, HOLD_MS + 100).command).toBe('commitThen:text')
    })

    it('drifting back under DRAG_PX after targeting returns to plain holding (commits on release)', () => {
      let s = held()
      s = move(s, -DRAG_PX, 0)
      expect(s.phase).toBe('dragging')
      s = move(s, -2, 1)
      expect(s.phase).toBe('holding')
      expect(s.target).toBeUndefined()
      expect(release(s, HOLD_MS + 100).command).toBe('commit')
    })

    it('exact DRAG_PX boundary counts as past threshold; one px under does not', () => {
      expect(move(held(), -DRAG_PX, 0).phase).toBe('dragging')
      expect(move(held(), -(DRAG_PX - 1), 0).phase).toBe('holding')
    })
  })

  describe('pre-hold drag cancels candidacy (scroll intent)', () => {
    it('a move past DRAG_PX while still "pressed" (before HOLD_MS) resets to idle', () => {
      const s = press(IDLE_STATE, 0)
      const afterDrift = move(s, DRAG_PX + 10, 0)
      expect(afterDrift).toEqual(IDLE_STATE)
    })

    it('once cancelled, a later tick never re-engages holding', () => {
      let s = press(IDLE_STATE, 0)
      s = move(s, 0, -(DRAG_PX + 5))
      expect(s.phase).toBe('idle')
      s = tick(s, HOLD_MS + 1000)
      expect(s.phase).toBe('idle')
    })

    it('once cancelled, release yields no command at all — not even "tap"', () => {
      let s = press(IDLE_STATE, 0)
      s = move(s, DRAG_PX + 1, 0)
      const { state, command } = release(s, 10) // fast release, well under HOLD_MS
      expect(command).toBeUndefined()
      expect(state).toEqual(IDLE_STATE)
    })

    it('sub-threshold drift does NOT cancel candidacy — still a tap', () => {
      let s = press(IDLE_STATE, 0)
      s = move(s, DRAG_PX - 1, DRAG_PX - 1)
      expect(s.phase).toBe('pressed')
      expect(release(s, HOLD_MS - 1).command).toBe('tap')
    })
  })

  describe('cancel (pointercancel/pointerleave)', () => {
    it('resets any in-progress phase to idle', () => {
      expect(cancel(press(IDLE_STATE, 0))).toEqual(IDLE_STATE)
      expect(cancel(tick(press(IDLE_STATE, 0), HOLD_MS))).toEqual(IDLE_STATE)
      expect(cancel(move(tick(press(IDLE_STATE, 0), HOLD_MS), -DRAG_PX, 0))).toEqual(IDLE_STATE)
      expect(cancel(IDLE_STATE)).toEqual(IDLE_STATE)
    })
  })

  describe('no double commits', () => {
    it('release always returns the machine to idle, so a second release without a new press is inert', () => {
      const s = tick(press(IDLE_STATE, 0), HOLD_MS)
      const first = release(s, HOLD_MS + 10)
      expect(first.command).toBe('commit')
      const second = release(first.state, HOLD_MS + 20)
      expect(second.command).toBeUndefined()
    })

    it('move/tick after release are no-ops (idle absorbs stray events)', () => {
      const s = tick(press(IDLE_STATE, 0), HOLD_MS)
      const { state } = release(s, HOLD_MS + 10)
      expect(move(state, -100, 0)).toEqual(IDLE_STATE)
      expect(tick(state, HOLD_MS + 10000)).toEqual(IDLE_STATE)
    })

    it('fuzz: a random walk of events never yields two commit-class commands without an intervening press', () => {
      let rng = 42
      const rand = () => {
        // Deterministic LCG so failures are reproducible without a fixed seed dependency.
        rng = (rng * 1103515245 + 12345) & 0x7fffffff
        return rng / 0x7fffffff
      }
      const events = ['press', 'move', 'tick', 'release'] as const

      for (let trial = 0; trial < 200; trial++) {
        let s: GestureState = IDLE_STATE
        let t = 0
        let armed = false
        for (let step = 0; step < 30; step++) {
          const kind = events[Math.floor(rand() * events.length)]
          t += Math.floor(rand() * 300)
          if (kind === 'press') {
            s = press(s, t)
            armed = true
          } else if (kind === 'move') {
            const dx = Math.floor(rand() * 200) - 100
            const dy = Math.floor(rand() * 200) - 100
            s = move(s, dx, dy)
          } else if (kind === 'tick') {
            s = tick(s, t)
          } else {
            const { state, command } = release(s, t)
            if (command && COMMIT_CLASS.includes(command)) {
              expect(armed).toBe(true)
              armed = false
            }
            s = state
          }
        }
      }
    })
  })
})
