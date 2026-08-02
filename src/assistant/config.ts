/**
 * Assistant configuration. llm.elimelt.com is an OpenAI-compatible endpoint
 * (Ollama facade); no API key — access is origin-gated by CORS. The feature
 * is fully opt-in via AppSettings.assistantEnabled, and none of this code
 * loads until the user enables it (ChatScreen is lazy).
 */

export const ASSISTANT_BASE_URL = 'https://llm.elimelt.com/v1'

/** Curated models known to exist on the endpoint. First entry is the default. */
export const ASSISTANT_MODELS = [
  { id: 'gpt-oss:20b', label: 'GPT-OSS 20B' },
  { id: 'gemma3:27b', label: 'Gemma 3 27B' },
  { id: 'llama3.2:3b', label: 'Llama 3.2 3B (fastest)' },
] as const

/** Must match APP_DEFAULTS.assistantModel in store/settings.ts (store must
 * not import assistant/; the pairing is pinned by tests on both sides). */
export const DEFAULT_ASSISTANT_MODEL: string = ASSISTANT_MODELS[0].id

export function modelLabel(id: string): string {
  return ASSISTANT_MODELS.find((m) => m.id === id)?.label ?? id
}
