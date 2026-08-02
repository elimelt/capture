/**
 * Regression test for the "assistant is read-only" report: the write tools
 * must survive the whole client wiring — createAssistantTools (built exactly
 * the way ChatScreen builds it) → createAssistantTransport → ToolLoopAgent —
 * and actually execute. The OpenAI-compatible provider is mocked at the
 * module boundary so a scripted model can (a) prove every tool definition,
 * including create_entry and update_entry, reaches the model request, and
 * (b) drive both write tools end-to-end into a mocked EntryWriter with the
 * results streaming back as UI tool-output chunks.
 */
import 'fake-indexeddb/auto'
import { describe, expect, it, vi } from 'vitest'
import type { UIMessage } from 'ai'
import type { LanguageModelV3StreamPart } from '@ai-sdk/provider'
import { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test'
import { EVENT_SCHEMA, type AmendPatch, type Entry } from '../contract/types'
import type { NewAttachment } from '../store/events'
import { buildInstructions } from './context'
import { createAssistantTools, type EntryWriter } from './tools'
import { createAssistantTransport } from './transport'

// transport.ts builds its provider at module scope; swap it for one whose
// chatModel returns the scripted mock of the current test.
const holder = vi.hoisted(() => ({ model: undefined as unknown }))
vi.mock('@ai-sdk/openai-compatible', () => ({
  createOpenAICompatible: () => ({ chatModel: () => holder.model }),
}))

const USAGE = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
}

function userMessage(text: string): UIMessage {
  return { id: 'u1', role: 'user', parts: [{ type: 'text', text }] }
}

function noteEntry(id: string): Entry {
  return {
    id,
    seq: 1,
    stream: 'timelog',
    loggedAt: '2026-08-02T09:00:00-04:00',
    capturedAt: '2026-08-02T09:00:00-04:00',
    deviceTz: 'America/New_York',
    attachments: [{ kind: 'text', file: `${id}-note`, mimeType: 'text/plain' }],
    lastEventSeq: 1,
    revoked: false,
  }
}

/** Writer that records every call; capture mints ids new1, new2, … */
function recordedWriter() {
  const captures: Array<{ capturedAt: string; attachments: NewAttachment[] }> = []
  const amends: Array<{
    targets: string[]
    patch?: AmendPatch
    attachments?: NewAttachment[]
  }> = []
  const writer: EntryWriter = {
    capture: async (input) => {
      captures.push(input)
      return {
        schema: EVENT_SCHEMA,
        type: 'capture',
        id: `new${captures.length}`,
        seq: captures.length,
        stream: 'timelog',
        loggedAt: input.capturedAt,
        deviceTz: 'America/New_York',
        capturedAt: input.capturedAt,
        attachments: [],
      }
    },
    amend: async (input) => {
      amends.push(input)
    },
  }
  return { writer, captures, amends }
}

async function drain(stream: ReadableStream<{ type: string }>) {
  const chunks: Array<Record<string, unknown> & { type: string }> = []
  const reader = stream.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value.type === 'error') throw new Error(`stream error chunk: ${JSON.stringify(value)}`)
    chunks.push(value as Record<string, unknown> & { type: string })
  }
  return chunks
}

describe('assistant transport wiring (write tools)', () => {
  it('registers create_entry/update_entry with the model and executes them end-to-end', async () => {
    // Turn 1: the model calls both write tools; turn 2: it answers in text.
    const model = new MockLanguageModelV3({
      doStream: [
        {
          stream: convertArrayToReadableStream<LanguageModelV3StreamPart>([
            { type: 'stream-start', warnings: [] },
            {
              type: 'tool-call',
              toolCallId: 'call-1',
              toolName: 'create_entry',
              input: JSON.stringify({ text: 'buy milk' }),
            },
            {
              type: 'tool-call',
              toolCallId: 'call-2',
              toolName: 'update_entry',
              input: JSON.stringify({ id: 'e1', text: 'walked the dog at the park' }),
            },
            { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage: USAGE },
          ]),
        },
        {
          stream: convertArrayToReadableStream<LanguageModelV3StreamPart>([
            { type: 'stream-start', warnings: [] },
            { type: 'text-start', id: 't1' },
            { type: 'text-delta', id: 't1', delta: 'Done — logged it and fixed the entry.' },
            { type: 'text-end', id: 't1' },
            { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: USAGE },
          ]),
        },
      ],
    })
    holder.model = model

    // Toolset built exactly like ChatScreen.getChat: store getters + the
    // two write actions, wrapped by createAssistantTools.
    const entries = [noteEntry('e1')]
    const { writer, captures, amends } = recordedWriter()
    const transport = createAssistantTransport(
      'gpt-oss:20b',
      () => buildInstructions(),
      createAssistantTools(
        () => entries,
        () => [],
        writer,
      ),
    )

    const chunks = await drain(
      await transport.sendMessages({
        trigger: 'submit-message',
        chatId: 'wiring-test',
        messageId: undefined,
        abortSignal: undefined,
        messages: [userMessage('log "buy milk" and fix my 9am entry')],
      }),
    )

    // (a) Every tool — the three reads AND both writes — reached the model.
    const sentTools = (model.doStreamCalls[0]?.tools ?? []).map((t) => t.name)
    expect(sentTools.sort()).toEqual([
      'create_entry',
      'get_places',
      'list_entries',
      'search_entries',
      'update_entry',
    ])

    // The system prompt that travelled with the request affirms writes.
    const system = model.doStreamCalls[0]?.prompt.find((m) => m.role === 'system')
    expect(system?.content).toContain('you are not read-only')

    // (b) Both write tools executed against the injected writer.
    expect(captures).toHaveLength(1)
    expect(await captures[0].attachments[0].blob.text()).toBe('buy milk')
    expect(amends).toHaveLength(1)
    expect(amends[0].targets).toEqual(['e1'])

    // The tool results surfaced on the UI stream and the loop continued to a
    // final text answer (two model steps total).
    const outputs = chunks
      .filter((c) => c.type === 'tool-output-available')
      .map((c) => c.output)
    expect(outputs).toContain('Created entry new1.')
    expect(outputs).toContain('Updated entry e1.')
    expect(model.doStreamCalls).toHaveLength(2)
    const text = chunks
      .filter((c) => c.type === 'text-delta')
      .map((c) => c.delta)
      .join('')
    expect(text).toContain('Done')
  })
})
