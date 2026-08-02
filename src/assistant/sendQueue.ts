/**
 * Pure state machine for mid-turn message queueing in the assistant chat.
 * While a turn is in flight, submitted messages queue FIFO and flush one
 * per settled turn; "steer" promotes a queued message to the head and stops
 * the in-flight response, so the abort's own settle sends it immediately —
 * every send flows through the same settle path, which is what makes
 * ordering and no-double-send provable here without the SDK. Transitions
 * take a state and return the next state plus the commands the caller must
 * run (ChatScreen executes them via the chat's sendMessage/stop).
 */

export interface QueuedMessage {
  id: string
  text: string
}

export interface SendQueueState {
  /** A turn is in flight (chat status submitted/streaming). */
  turnInFlight: boolean
  /** Messages waiting to be sent, oldest first. */
  queue: readonly QueuedMessage[]
}

/** Side effects the caller must execute, in order. */
export type SendQueueCommand =
  | { type: 'send'; message: QueuedMessage }
  | { type: 'stop' }

export interface SendQueueTransition {
  state: SendQueueState
  commands: readonly SendQueueCommand[]
}

/** `turnInFlight` seeds from the live chat status: the screen can mount
 * while a stream it started earlier (module-scope Chat) is still running. */
export function initialSendQueue(turnInFlight = false): SendQueueState {
  return { turnInFlight, queue: [] }
}

/** User submits a message: send now when idle, enqueue (FIFO) mid-turn. */
export function submit(state: SendQueueState, message: QueuedMessage): SendQueueTransition {
  if (state.turnInFlight) {
    return { state: { ...state, queue: [...state.queue, message] }, commands: [] }
  }
  return { state: { ...state, turnInFlight: true }, commands: [{ type: 'send', message }] }
}

/**
 * The in-flight turn settled — status reached ready or error, including via
 * stop(). Flushes the queue head as the next turn; idle when nothing is
 * queued. The caller must dispatch this exactly once per settle (on the
 * status *transition*), which is what bounds sends to one per settled turn.
 */
export function settled(state: SendQueueState): SendQueueTransition {
  const [head, ...rest] = state.queue
  if (!head) return { state: { ...state, turnInFlight: false }, commands: [] }
  return { state: { turnInFlight: true, queue: rest }, commands: [{ type: 'send', message: head }] }
}

/**
 * Steer: interrupt the in-flight response and send queued message `id`
 * next. Mid-turn this promotes it to the queue head and emits only `stop`;
 * the abort settles the turn and that settle flushes it — no second code
 * path racing the aborting stream. Any other queued messages keep their
 * relative order and continue on later settles. Unknown id is a no-op;
 * when idle (turn settled between render and tap) it degrades to an
 * immediate send.
 */
export function steer(state: SendQueueState, id: string): SendQueueTransition {
  const target = state.queue.find((m) => m.id === id)
  if (!target) return { state, commands: [] }
  const rest = state.queue.filter((m) => m.id !== id)
  if (!state.turnInFlight) {
    return { state: { turnInFlight: true, queue: rest }, commands: [{ type: 'send', message: target }] }
  }
  return { state: { turnInFlight: true, queue: [target, ...rest] }, commands: [{ type: 'stop' }] }
}

/** Drop a queued message (the pending bubble's Remove action). No-op for
 * unknown ids. */
export function discard(state: SendQueueState, id: string): SendQueueTransition {
  const queue = state.queue.filter((m) => m.id !== id)
  if (queue.length === state.queue.length) return { state, commands: [] }
  return { state: { ...state, queue }, commands: [] }
}
