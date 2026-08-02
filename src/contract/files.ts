/**
 * Serializers for the non-event contract files (SPEC §5.1, §5.3, §5.4):
 * streams.json, <stream>/config.json, and the checkpoint.json stub. Same
 * wire conventions as serialize.ts — fixed key order, 2-space indent,
 * trailing newline, optional fields omitted entirely (never null).
 *
 * config.json and checkpoint.json are mutable derived files the skill owns;
 * the app only ever writes them as *stubs* so drive.file can read them back
 * (SPEC §5.5, §11). The app must not clobber a skill's later edits, so these
 * serializers are used to create the file when absent — never to overwrite.
 */

export const STREAMS_SCHEMA = 'capture.streams.v1'
export const STREAM_CONFIG_SCHEMA = 'capture.streamconfig.v1'
export const CHECKPOINT_SCHEMA = 'capture.checkpoint.v1'

/** streams.json — registry of streams the app has bootstrapped (§5.1). */
export interface StreamsRegistry {
  streams: string[]
}

/** <stream>/config.json — generic header + opaque skillConfig body (§5.3). */
export interface StreamConfig {
  stream: string
  /** Free-shape body owned by the stream's skill; app treats it as opaque. */
  skillConfig?: Record<string, unknown>
  /** Free text the user edits to give the skill standing context. */
  userNotes?: string
}

/** checkpoint.json — the consumer's cursor into the log (§5.4). */
export interface Checkpoint {
  stream: string
  consumedThroughSeq: number
  /** ISO-8601 with local offset. */
  updatedAt: string
  /** Set by the skill on first run; omitted in the app-created stub. */
  consumer?: string
}

type Json = Record<string, unknown>

function toFile(obj: Json): string {
  return `${JSON.stringify(obj, null, 2)}\n`
}

export function serializeStreamsRegistry(reg: StreamsRegistry): string {
  return toFile({ schema: STREAMS_SCHEMA, streams: reg.streams })
}

export function serializeStreamConfig(cfg: StreamConfig): string {
  const out: Json = { schema: STREAM_CONFIG_SCHEMA, stream: cfg.stream }
  if (cfg.skillConfig !== undefined) out.skillConfig = cfg.skillConfig
  if (cfg.userNotes !== undefined) out.userNotes = cfg.userNotes
  return toFile(out)
}

export function serializeCheckpoint(cp: Checkpoint): string {
  const out: Json = {
    schema: CHECKPOINT_SCHEMA,
    stream: cp.stream,
    consumedThroughSeq: cp.consumedThroughSeq,
    updatedAt: cp.updatedAt,
  }
  if (cp.consumer !== undefined) out.consumer = cp.consumer
  return toFile(out)
}

/**
 * The empty checkpoint the app writes at stream bootstrap: nothing consumed
 * yet, no consumer named (the skill fills that in on its first run).
 */
export function checkpointStub(stream: string, updatedAt: string): Checkpoint {
  return { stream, consumedThroughSeq: 0, updatedAt }
}

/**
 * The empty config the app writes at stream bootstrap: an empty opaque body
 * and empty user notes, both of which the user/skill fill in later.
 */
export function streamConfigStub(stream: string): StreamConfig {
  return { stream, skillConfig: {}, userNotes: '' }
}
