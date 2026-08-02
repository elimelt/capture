/**
 * Idempotent Drive tree bootstrap (SPEC §5.1, §8.4, §11). Ensures the
 * timebox/ root, streams.json registry, and — per stream — the stream folder,
 * config.json + checkpoint.json app-created stubs, an immutable log/ folder,
 * and a results/ folder. Safe to re-run: every step finds-before-creates and
 * mutable stubs are only created when absent (never clobbering skill edits,
 * §5.5). Minted ids are cached in meta (tree.ts) to short-circuit later
 * drains; the cache is account-bound (account.ts), so a Google-account switch
 * discards it here before any cached ids are merged or reused. Everything
 * created here is tagged with appProperties (tags.ts) at creation time —
 * free, app-private metadata for future single-query discovery.
 */
import { toLocalIso } from '../contract/time'
import {
  checkpointStub,
  serializeCheckpoint,
  serializeStreamConfig,
  serializeStreamsRegistry,
  streamConfigStub,
} from '../contract/files'
import { FOLDER_MIME, createFolder, findFile, uploadFile } from './client'
import { ensureAccountBound } from './account'
import { tags, type TagKind } from './tags'
import { emptyStreamTree, getTree, saveTree, type DriveTree, type StreamTree } from './tree'

const ROOT_FOLDER = 'timebox'

/** Find a subfolder by name under a parent, creating it (tagged) if absent. */
async function ensureFolder(
  token: string,
  name: string,
  parentId: string,
  kind: TagKind,
  stream?: string,
): Promise<string> {
  const existing = await findFile(token, { name, parentId, mimeType: FOLDER_MIME })
  return existing ?? (await createFolder(token, name, parentId, tags(kind, stream)))
}

/**
 * Ensure a fixed non-folder file exists under a parent, creating it from
 * `content` only when absent. Returns nothing: these files are addressed by
 * name at read time, and mutable stubs must never be re-uploaded (§5.5).
 */
async function ensureFile(
  token: string,
  name: string,
  parentId: string,
  mimeType: string,
  content: string,
  kind: TagKind,
  stream?: string,
): Promise<void> {
  const existing = await findFile(token, { name, parentId })
  if (existing === null) {
    await uploadFile(token, {
      name,
      parentId,
      mimeType,
      body: content,
      appProperties: tags(kind, stream),
    })
  }
}

async function ensureStream(token: string, rootId: string, stream: string): Promise<StreamTree> {
  const folderId = await ensureFolder(token, stream, rootId, 'stream', stream)
  const logId = await ensureFolder(token, 'log', folderId, 'log', stream)
  const resultsId = await ensureFolder(token, 'results', folderId, 'results', stream)
  // App-created stubs so drive.file can read them back after a skill updates
  // them (§11). Only written when absent — never overwriting a skill's edits.
  await ensureFile(
    token,
    'config.json',
    folderId,
    'application/json',
    serializeStreamConfig(streamConfigStub(stream)),
    'config',
    stream,
  )
  await ensureFile(
    token,
    'checkpoint.json',
    folderId,
    'application/json',
    serializeCheckpoint(checkpointStub(stream, toLocalIso(new Date()))),
    'checkpoint',
    stream,
  )
  return emptyStreamTree(folderId, logId, resultsId)
}

/**
 * Ensure the whole tree for the given streams and persist the id cache.
 * Returns the up-to-date DriveTree. Re-running merges: streams already cached
 * keep their partition ids; newly requested streams are added. The cache is
 * bound to the Google account (account.ts): after an account switch it is
 * discarded before the merge, so stale wrong-account ids never survive into
 * the fresh tree.
 */
export async function ensureTree(token: string, streams: string[]): Promise<DriveTree> {
  await ensureAccountBound(token)
  const rootId = await ensureFolder(token, ROOT_FOLDER, 'root', 'root')
  const cached = await getTree()
  const tree: DriveTree = { rootId, streams: { ...cached?.streams } }

  for (const stream of streams) {
    const sub = await ensureStream(token, rootId, stream)
    // Preserve any cached partition ids for a stream we've bootstrapped before.
    const priorPartitions = cached?.streams[stream]?.partitions ?? {}
    tree.streams[stream] = { ...sub, partitions: priorPartitions }
  }

  // streams.json registry lists every stream the app has bootstrapped.
  await ensureRegistry(token, rootId, Object.keys(tree.streams))

  await saveTree(tree)
  return tree
}

/**
 * The registry names which streams exist; unlike the mutable stubs it is
 * app-owned, so we (re)write it to reflect the current set. Created if absent,
 * updated in place otherwise.
 */
async function ensureRegistry(token: string, rootId: string, streams: string[]): Promise<void> {
  const body = serializeStreamsRegistry({ streams })
  const existing = await findFile(token, { name: 'streams.json', parentId: rootId })
  if (existing === null) {
    await uploadFile(token, {
      name: 'streams.json',
      parentId: rootId,
      mimeType: 'application/json',
      body,
      appProperties: tags('registry'),
    })
  }
  // When present we leave it as-is: v1 only ever bootstraps timelog, so the
  // set never shrinks and a rewrite would need an update (PATCH) path we defer
  // until a second stream ships (§12 M5 extensibility dry-run).
}
