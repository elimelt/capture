/**
 * Enrichment endpoint + model configuration — the fork/self-host seam
 * (issue #62). Previously each pipeline's api.ts buried its own base URL and
 * model name, so pointing the app at a different Whisper/Ollama-compatible
 * host meant editing two source files. Now there is exactly one file to
 * change.
 *
 * Editing a URL here must be paired with editing `index.html`'s CSP
 * `connect-src` (AGENTS.md's "any new external network endpoint" rule) — the
 * browser blocks the request regardless of this config otherwise.
 */

/** Speaches / OpenAI-compatible Whisper endpoint (src/transcribe/api.ts). */
export const TRANSCRIBE_BASE_URL = 'https://transcribe.elimelt.com'
export const TRANSCRIBE_MODEL = 'Systran/faster-whisper-base.en'

/** Ollama-style vision-chat endpoint (src/vision/api.ts). */
export const VISION_CHAT_URL = 'https://llm.elimelt.com/api/chat'
export const VISION_MODEL = 'gemma4:e4b'
