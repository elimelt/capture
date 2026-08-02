/**
 * Overlay event repository — the only writer of the calendar-overlay log
 * (SPEC §3.6, §5.6). Mirrors src/store/events.ts in miniature: appends are
 * atomic (per-stream seq allocation from the shared `meta` counter + the
 * event record in one IndexedDB transaction), events are keyed by `id` in the
 * `overlayEvents` store, and read state is always a fresh fold.
 *
 * Lives under gcal/ (not store/) because the log is calendar-domain state and
 * store/ must never import gcal/ (SPEC §10); like other domain modules it
 * imports getDb() from store/db directly. No sync rows are written: the log
 * is local-only until it is wired into the multi-stream sync engine.
 */
import { newEventId } from '../../contract/ids'
import { deviceTz, toLocalIso } from '../../contract/time'
import { getDb } from '../../store/db'
import { seqKey } from '../../store/metaKeys'
import { compareOverlayEvents, foldOverlay, type OverlayFoldOptions } from './fold'
import type {
  CalendarEventRef,
  OverlayAmendEvent,
  OverlayBaseSnapshot,
  OverlayCreateEvent,
  OverlayLogEvent,
  OverlayPatch,
  OverlayRevokeEvent,
  OverlayState,
} from './types'
import { OVERLAY_SCHEMA, OVERLAY_STREAM } from './types'

/** Same shared per-stream counter convention as store/events.ts, via the
 * central `store/metaKeys.ts` registry (issue #57) — no re-derived template. */
const SEQ_KEY = seqKey(OVERLAY_STREAM)

interface AppendBase {
  id: string
  seq: number
  loggedAt: string
  deviceTz: string
}

async function append(build: (base: AppendBase) => OverlayLogEvent): Promise<OverlayLogEvent> {
  const db = await getDb()
  const tx = db.transaction(['overlayEvents', 'meta'], 'readwrite')
  const nextSeq = ((await tx.objectStore('meta').get(SEQ_KEY)) as number | undefined) ?? 1
  const event = build({
    id: newEventId(),
    seq: nextSeq,
    loggedAt: toLocalIso(new Date()),
    deviceTz: deviceTz(),
  })
  await tx.objectStore('meta').put(nextSeq + 1, SEQ_KEY)
  await tx.objectStore('overlayEvents').put(event)
  await tx.done
  return event
}

/** Materialize an overlay: freeze the base snapshot and apply the first patch. */
export async function appendOverlayCreate(input: {
  target: CalendarEventRef
  baseSnapshot: OverlayBaseSnapshot
  patch: OverlayPatch
}): Promise<OverlayCreateEvent> {
  return (await append((base) => ({
    schema: OVERLAY_SCHEMA,
    type: 'overlay',
    stream: OVERLAY_STREAM,
    target: input.target,
    baseSnapshot: input.baseSnapshot,
    patch: input.patch,
    ...base,
  }))) as OverlayCreateEvent
}

export async function appendOverlayAmend(input: {
  targets: string[]
  patch?: OverlayPatch
}): Promise<OverlayAmendEvent> {
  return (await append((base) => ({
    schema: OVERLAY_SCHEMA,
    type: 'amend',
    stream: OVERLAY_STREAM,
    targets: input.targets,
    ...(input.patch ? { patch: input.patch } : {}),
    ...base,
  }))) as OverlayAmendEvent
}

export async function appendOverlayRevoke(input: {
  targets: string[]
}): Promise<OverlayRevokeEvent> {
  return (await append((base) => ({
    schema: OVERLAY_SCHEMA,
    type: 'revoke',
    stream: OVERLAY_STREAM,
    targets: input.targets,
    ...base,
  }))) as OverlayRevokeEvent
}

/** The whole overlay log in log order (seq → loggedAt → id). */
export async function listOverlayEvents(): Promise<OverlayLogEvent[]> {
  const db = await getDb()
  // The store is keyed by id, so the index yields id order; re-sort into the
  // same total order the fold uses. Rows are opaque to store/db (layering);
  // this module owns the strong typing.
  const rows = await db.getAllFromIndex('overlayEvents', 'by-stream', OVERLAY_STREAM)
  return (rows as unknown as OverlayLogEvent[]).sort(compareOverlayEvents)
}

/** The folded, effective overlay states (SPEC §3.6). */
export async function listOverlayStates(opts: OverlayFoldOptions = {}): Promise<OverlayState[]> {
  return foldOverlay(await listOverlayEvents(), opts)
}
