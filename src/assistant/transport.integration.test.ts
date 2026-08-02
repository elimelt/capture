/**
 * Live integration test for the assistant transport: calls the real
 * llm.elimelt.com endpoint end-to-end through createAssistantTransport and
 * asserts that the response actually *streams* (many incremental text-deltas
 * spread over time, not one blob at the end).
 *
 * Network-dependent, so excluded from `npm test`; run with
 * `npm run test:integration`.
 */
import { describe, expect, it } from 'vitest'
import type { UIMessage } from 'ai'
import { createAssistantTransport } from './transport'

const TIMEOUT_MS = 90_000

function userMessage(text: string): UIMessage {
  return { id: 'u1', role: 'user', parts: [{ type: 'text', text }] }
}

describe('assistant transport (live API)', () => {
  it(
    'streams incremental text-deltas from llm.elimelt.com',
    { timeout: TIMEOUT_MS },
    async () => {
      const transport = createAssistantTransport('llama3.2:3b', () =>
        Promise.resolve('You are a helpful assistant. Be brief.'),
      )

      const stream = await transport.sendMessages({
        trigger: 'submit-message',
        chatId: 'integration-test',
        messageId: undefined,
        abortSignal: undefined,
        messages: [userMessage('Count from 1 to 20, one number per line.')],
      })

      const types: string[] = []
      const deltaTimes: number[] = []
      let text = ''
      const t0 = Date.now()

      const reader = stream.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        types.push(value.type)
        if (value.type === 'error') {
          throw new Error(`stream error chunk: ${JSON.stringify(value)}`)
        }
        if (value.type === 'text-delta') {
          deltaTimes.push(Date.now() - t0)
          text += value.delta
        }
      }

      // Lifecycle chunks arrived in order.
      expect(types[0]).toBe('start')
      expect(types.at(-1)).toBe('finish')
      expect(types).toContain('text-start')
      expect(types).toContain('text-end')

      // The model actually answered.
      expect(text).toContain('1')
      expect(text.length).toBeGreaterThan(10)

      // Genuine streaming: many separate deltas, spread over time rather
      // than all flushed in one final burst.
      expect(deltaTimes.length).toBeGreaterThanOrEqual(5)
      const spread = deltaTimes.at(-1)! - deltaTimes[0]
      expect(spread).toBeGreaterThan(50)
    },
  )
})
