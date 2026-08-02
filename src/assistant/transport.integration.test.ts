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
import { jsonSchema, tool, type UIMessage } from 'ai'
import { createAssistantTransport } from './transport'

const TIMEOUT_MS = 90_000
const TOOL_TIMEOUT_MS = 120_000

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

  it(
    'runs client-side tools through the tool loop (gpt-oss:20b)',
    { timeout: TOOL_TIMEOUT_MS },
    async () => {
      const tools = {
        get_test_number: tool({
          description: 'Returns the secret test number.',
          inputSchema: jsonSchema<Record<string, never>>({
            type: 'object',
            properties: {},
            additionalProperties: false,
          }),
          execute: async () => 'The secret test number is 42.',
        }),
      }
      const transport = createAssistantTransport(
        'gpt-oss:20b',
        () =>
          Promise.resolve(
            'You are a test assistant. Answer questions about the secret test number by calling the get_test_number tool.',
          ),
        tools,
      )

      const stream = await transport.sendMessages({
        trigger: 'submit-message',
        chatId: 'integration-test-tools',
        messageId: undefined,
        abortSignal: undefined,
        messages: [userMessage('What is the secret test number? Use your tool to find out.')],
      })

      const types: string[] = []
      let text = ''
      const reader = stream.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        types.push(value.type)
        if (value.type === 'error') {
          throw new Error(`stream error chunk: ${JSON.stringify(value)}`)
        }
        if (value.type === 'text-delta') text += value.delta
      }

      // The tool call flowed through the UI stream: input announced,
      // parsed, and the client-side execute result surfaced.
      expect(types).toContain('tool-input-start')
      expect(types).toContain('tool-input-available')
      expect(types).toContain('tool-output-available')

      // The model grounded its answer in the tool output.
      expect(text).toContain('42')
    },
  )
})
