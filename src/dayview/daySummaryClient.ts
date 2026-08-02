/**
 * Direct fetch to the OpenAI-compatible chat-completions endpoint for the
 * opt-in daily prose (#82). Deliberately NOT the assistant/transport.ts
 * DirectChatTransport/ToolLoopAgent path: that pulls in the `ai` and
 * `@ai-sdk/openai-compatible` packages, which is exactly the chunk issue #82
 * (requirement 7) says must stay out of the Day screen's bundle (it's
 * ChatScreen's lazy chunk today — see vite.config.ts globIgnores). A single
 * one-shot fetch needs none of that: no streaming, no tools, no history.
 */
import { ASSISTANT_BASE_URL } from '../assistant/config'
import type { DaySummaryPrompt } from './prosePrompt'

interface ChatCompletionResponse {
  choices?: { message?: { content?: string } }[]
}

/**
 * Posts the prompt and returns the trimmed prose, or `undefined` on any
 * failure (offline, non-2xx, malformed body, empty completion) — never
 * throws, so a failed generation never blocks the deterministic stat line
 * that already rendered.
 */
export async function fetchDaySummary(
  prompt: DaySummaryPrompt,
  model: string,
): Promise<string | undefined> {
  try {
    const res = await fetch(`${ASSISTANT_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: false,
        max_tokens: 120,
        messages: [
          { role: 'system', content: prompt.system },
          { role: 'user', content: prompt.user },
        ],
      }),
    })
    if (!res.ok) return undefined
    const data = (await res.json()) as ChatCompletionResponse
    const text = data.choices?.[0]?.message?.content?.trim()
    return text ? text : undefined
  } catch {
    return undefined
  }
}
