import { getDb } from './db'

export interface AppSettings {
  locationEnabled: boolean
  /** AI assistant is fully opt-in; the chat tab and code stay absent until enabled. */
  assistantEnabled: boolean
  /** Model id on the LLM endpoint (curated list in assistant/config.ts). */
  assistantModel: string
}

export interface StreamSettings {
  maxClipSec: number
  keepAudioLocally: boolean
}

const APP_DEFAULTS: AppSettings = {
  locationEnabled: true,
  assistantEnabled: false,
  assistantModel: 'gpt-oss:20b',
}
const STREAM_DEFAULTS: StreamSettings = { maxClipSec: 60, keepAudioLocally: true }

export async function getSettings(): Promise<AppSettings> {
  const db = await getDb()
  const stored = (await db.get('meta', 'settings:app')) as Partial<AppSettings> | undefined
  return { ...APP_DEFAULTS, ...stored }
}

export async function saveSettings(settings: AppSettings): Promise<void> {
  const db = await getDb()
  await db.put('meta', settings, 'settings:app')
}

export async function getStreamSettings(stream: string): Promise<StreamSettings> {
  const db = await getDb()
  const stored = (await db.get('meta', `settings:stream:${stream}`)) as
    | Partial<StreamSettings>
    | undefined
  return { ...STREAM_DEFAULTS, ...stored }
}

export async function saveStreamSettings(
  stream: string,
  settings: StreamSettings,
): Promise<void> {
  const db = await getDb()
  await db.put('meta', settings, `settings:stream:${stream}`)
}
