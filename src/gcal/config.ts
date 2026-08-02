/**
 * Target-calendar selection (SPEC §4.3, §5.3). The Day view reads one calendar;
 * this module owns which one. Two layers of truth, in priority order:
 *
 *   1. a local `meta` row — instant, offline, the Day view's source of truth;
 *   2. `<stream>/config.json` on Drive under `skillConfig.targetCalendar` — the
 *      durable copy a future skill / another device reads back (§5.3).
 *
 * `setTargetCalendar` writes local first (so the UI/Day view react immediately
 * even offline) then best-effort mirrors into Drive; a Drive failure surfaces to
 * the caller but never loses the local pick. Read-modify-write preserves the
 * rest of `skillConfig` and `userNotes` — the app must not clobber skill edits
 * (§5.5). gcal/ is timelog-specific and may lean on the generic drive/, store/,
 * contract/ and streams/ layers; never the reverse (§10).
 */
import {
  STREAM_CONFIG_SCHEMA,
  serializeStreamConfig,
  type StreamConfig,
} from '../contract/files'
import { ensureTree } from '../drive/bootstrap'
import { findFile, readFileText, updateFileContent } from '../drive/client'
import { getDb } from '../store/db'
import { TIMELOG_STREAM } from '../streams/registry'
import type { CalendarSummary } from './events'

const TARGET_KEY = 'gcal:targetCalendar'
const CONFIG_MIME = 'application/json'

/** The chosen calendar, stored locally and mirrored into config.json (§5.3). */
export interface TargetCalendar {
  id: string
  summary: string
}

/** The locally-cached target calendar, or undefined if none is chosen yet. */
export async function getTargetCalendar(): Promise<TargetCalendar | undefined> {
  const db = await getDb()
  return (await db.get('meta', TARGET_KEY)) as TargetCalendar | undefined
}

/**
 * Decide the Settings picker's initial selection and whether a default must be
 * persisted right now. Pure — this is the "should we auto-pick?" logic behind
 * `CalendarPicker`, extracted so the regression stays pinned by tests: the
 * picker used to *display* the primary calendar as selected without persisting
 * it, so `getTargetCalendar()` stayed empty and the Day view sat on
 * `no-calendar` until the user manually switched calendars.
 *
 * Rules, in order:
 *  - a stored target always wins and is never re-persisted (`autoPick` is
 *    undefined, so repeat Settings visits cause no redundant writes) — even if
 *    it is momentarily absent from the fetched list;
 *  - nothing stored → the primary calendar is both selected and returned as
 *    `autoPick` for the caller to persist immediately;
 *  - nothing stored and no primary → keep the placeholder, persist nothing.
 */
export function resolveTargetSelection(
  stored: TargetCalendar | undefined,
  calendars: CalendarSummary[],
): { selectedId: string; autoPick: TargetCalendar | undefined } {
  if (stored !== undefined) return { selectedId: stored.id, autoPick: undefined }
  const primary = calendars.find((c) => c.primary)
  if (primary === undefined) return { selectedId: '', autoPick: undefined }
  return { selectedId: primary.id, autoPick: { id: primary.id, summary: primary.summary } }
}

async function saveTargetLocal(target: TargetCalendar): Promise<void> {
  const db = await getDb()
  await db.put('meta', target, TARGET_KEY)
}

/**
 * Merge a target calendar into a config.json body, preserving every other field.
 * Pure so it can be unit-tested without Drive: takes the file's current text
 * (or undefined when the file couldn't be read) and returns the text to write.
 * A missing/corrupt body falls back to a fresh stub for the stream.
 */
export function mergeTargetCalendar(
  stream: string,
  currentText: string | undefined,
  target: TargetCalendar,
): string {
  const parsed = parseConfig(currentText)
  const cfg: StreamConfig = {
    stream,
    skillConfig: { ...parsed?.skillConfig, targetCalendar: { ...target } },
    ...(parsed?.userNotes !== undefined ? { userNotes: parsed.userNotes } : {}),
  }
  return serializeStreamConfig(cfg)
}

/** Best-effort parse of config.json text into the parts we preserve. */
function parseConfig(text: string | undefined): StreamConfig | undefined {
  if (text === undefined) return undefined
  try {
    const obj = JSON.parse(text) as {
      schema?: string
      stream?: string
      skillConfig?: Record<string, unknown>
      userNotes?: string
    }
    if (obj.schema !== STREAM_CONFIG_SCHEMA) return undefined
    return {
      stream: obj.stream ?? '',
      ...(obj.skillConfig !== undefined ? { skillConfig: obj.skillConfig } : {}),
      ...(obj.userNotes !== undefined ? { userNotes: obj.userNotes } : {}),
    }
  } catch {
    return undefined
  }
}

/**
 * Persist the chosen calendar: local first (never lost), then read-modify-write
 * into the stream's config.json on Drive. Requires a valid token for the Drive
 * mirror; a Drive error propagates after the local save so the UI can warn while
 * the Day view still works. The stream folder is ensured via the shared,
 * idempotent bootstrap so config.json exists before we patch it.
 */
export async function setTargetCalendar(
  token: string,
  target: TargetCalendar,
): Promise<void> {
  await saveTargetLocal(target)

  const stream = TIMELOG_STREAM.id
  const tree = await ensureTree(token, [stream])
  const folderId = tree.streams[stream]?.folderId
  if (folderId === undefined) return
  const fileId = await findFile(token, { name: 'config.json', parentId: folderId })
  if (fileId === null) return

  const currentText = await readFileText(token, fileId)
  const next = mergeTargetCalendar(stream, currentText, target)
  await updateFileContent(token, fileId, CONFIG_MIME, next)
}
