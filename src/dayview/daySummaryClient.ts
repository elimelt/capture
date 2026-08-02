/**
 * Direct fetch to the LLM host's native (Ollama-style) /api/chat endpoint for
 * the opt-in daily prose (#82). Two deliberate departures from the assistant:
 *
 * - NOT the assistant/transport.ts DirectChatTransport/ToolLoopAgent path:
 *   that pulls in the `ai` and `@ai-sdk/openai-compatible` packages, which is
 *   exactly the chunk issue #82 (requirement 7) says must stay out of the Day
 *   screen's bundle (it's ChatScreen's lazy chunk today — see vite.config.ts
 *   globIgnores). A single one-shot fetch needs none of that: no streaming,
 *   no tools, no history.
 *
 * - NOT the assistant's model or the OpenAI-compat /v1 endpoint: the chat
 *   default (gpt-oss:20b) is a reasoning model kept only for its well-formed
 *   tool_calls, and a small num_predict budget gets consumed entirely by its
 *   `reasoning` field, returning empty `content`. Only the native API honors
 *   `think: false` (same reason vision/api.ts uses it), so the prose runs on
 *   the non-reasoning gemma path instead.
 */
import { ASSISTANT_BASE_URL } from '../assistant/config'
import type { DaySummaryPrompt } from './prosePrompt'

/** Native chat endpoint on the same host as the OpenAI-compat /v1. */
const CHAT_URL = `${ASSISTANT_BASE_URL.replace(/\/v1$/, '')}/api/chat`
/** Non-reasoning model for one-shot prose; no tool_calls needed here. */
const MODEL = 'gemma4:e4b'
const MAX_TOKENS = 120
const TIMEOUT_MS = 60_000

interface NativeChatResponse {
  message?: { content?: unknown }
}

/**
 * Posts the prompt and returns the trimmed prose, or `undefined` on any
 * failure (offline, non-2xx, malformed body, empty completion) — never
 * throws, so a failed generation never blocks the deterministic stat line
 * that already rendered.
 */
export async function fetchDaySummary(prompt: DaySummaryPrompt): Promise<string | undefined> {
  try {
    const res = await fetch(CHAT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        think: false,
        stream: false,
        options: { num_predict: MAX_TOKENS },
        messages: [
          { role: 'system', content: prompt.system },
          { role: 'user', content: prompt.user },
        ],
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!res.ok) return undefined
    const data = (await res.json()) as NativeChatResponse
    const content = data.message?.content
    if (typeof content !== 'string') return undefined
    const text = content.trim()
    return text ? text : undefined
  } catch {
    return undefined
  }
}
