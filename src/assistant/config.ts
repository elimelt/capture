/**
 * Assistant configuration. llm.elimelt.com is an OpenAI-compatible endpoint
 * (Ollama facade); no API key — access is origin-gated by CORS. The feature
 * is fully opt-in via AppSettings.assistantEnabled, and none of this code
 * loads until the user enables it (ChatScreen is lazy).
 */
import { ENDPOINTS } from '../config'

/** Re-exported from the build-config module (`src/config.ts`, issue #69) so
 * every other endpoint move is a one-line diff there, not a hunt across
 * three modules plus the CSP. */
export const ASSISTANT_BASE_URL = ENDPOINTS.assistant

/** Curated models known to exist on the endpoint. First entry is the default.
 * gpt-oss:20b is the only hosted model that emits well-formed tool_calls,
 * which the assistant now relies on to read the log. */
export const ASSISTANT_MODELS = [{ id: 'gpt-oss:20b', label: 'GPT-OSS 20B' }] as const

/** Must match APP_DEFAULTS.assistantModel in store/settings.ts (store must
 * not import assistant/; the pairing is pinned by tests on both sides). */
export const DEFAULT_ASSISTANT_MODEL: string = ASSISTANT_MODELS[0].id

export function modelLabel(id: string): string {
  return ASSISTANT_MODELS.find((m) => m.id === id)?.label ?? id
}
