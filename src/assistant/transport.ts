/**
 * Client-side chat transport. The PWA has no server, so the AI SDK's
 * DirectChatTransport runs the agent in-process against the
 * OpenAI-compatible endpoint. The agent reads the log through read-only
 * tools; instructions are re-built per message so the current-time header
 * stays fresh.
 */
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import {
  DirectChatTransport,
  ToolLoopAgent,
  type ChatTransport,
  type ToolSet,
  type UIMessage,
} from 'ai'
import { ASSISTANT_BASE_URL } from './config'

/** Verbose chunk/request logging during local development only. */
const DEBUG =
  typeof location !== 'undefined' &&
  (location.hostname === 'localhost' || location.hostname === '127.0.0.1')

function debug(...args: unknown[]) {
  if (DEBUG) console.debug('[assistant]', ...args)
}

/**
 * The AI SDK appends attribution suffixes to the `user-agent` header
 * (`ai-sdk-agent/tool-loop`, `ai-sdk/openai-compatible/<v>`). Browsers that
 * honor a caller-set user-agent add it to the CORS preflight, and
 * llm.elimelt.com only allowlists `Content-Type, Authorization` — the request
 * dies before a single byte streams. Strip it at the fetch boundary.
 */
const assistantFetch: typeof fetch = async (input, init) => {
  const headers = new Headers(init?.headers)
  headers.delete('user-agent')
  const t0 = Date.now()
  debug('request', typeof input === 'string' ? input : (input as Request | URL).toString?.())
  const res = await fetch(input, { ...init, headers })
  debug('response', res.status, res.headers.get('content-type'), `${Date.now() - t0}ms`)
  return res
}

const provider = createOpenAICompatible({
  name: 'timebox-llm',
  baseURL: ASSISTANT_BASE_URL,
  fetch: assistantFetch,
})

/** Logs each UI stream chunk with timing; pass-through when DEBUG is off. */
function tapStream<T extends { type: string }>(stream: ReadableStream<T>): ReadableStream<T> {
  if (!DEBUG) return stream
  const t0 = Date.now()
  let deltas = 0
  return stream.pipeThrough(
    new TransformStream<T, T>({
      transform(chunk, controller) {
        if (chunk.type === 'text-delta') {
          deltas++
          if (deltas === 1) debug(`first text-delta at ${Date.now() - t0}ms`)
        } else {
          debug(`chunk ${chunk.type} at ${Date.now() - t0}ms`, chunk.type === 'error' ? chunk : '')
        }
        controller.enqueue(chunk)
      },
      flush() {
        debug(`stream done: ${deltas} text-deltas in ${Date.now() - t0}ms`)
      },
    }),
  )
}

export function createAssistantTransport(
  modelId: string,
  instructions: () => string | Promise<string>,
  tools: ToolSet = {},
): ChatTransport<UIMessage> {
  return {
    async sendMessages(options) {
      const agent = new ToolLoopAgent({
        model: provider.chatModel(modelId),
        instructions: await instructions(),
        tools,
        // gpt-oss reasoning effort (the server rejects the knob for
        // non-thinking models). Low cuts warm first-content latency from
        // ~24s to ~7s and, in testing, dated "yesterday" more reliably than
        // high (which overthought itself into the wrong day).
        ...(modelId.startsWith('gpt-oss')
          ? { providerOptions: { openaiCompatible: { reasoningEffort: 'low' } } }
          : {}),
      })
      // DirectChatTransport defaults to UIMessage<unknown, never, ...> (no
      // data parts); our chat uses the plain UIMessage shape (text plus
      // generic tool parts, no custom data parts), so the widening is safe.
      const direct = new DirectChatTransport({ agent }) as unknown as ChatTransport<UIMessage>
      return tapStream(await direct.sendMessages(options))
    },
    reconnectToStream: () => Promise.resolve(null),
  }
}
