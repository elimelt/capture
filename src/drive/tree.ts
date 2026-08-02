/**
 * Drive file-id cache (SPEC §8, §11). `drive.file` scope means the app can
 * only see files it created, so we remember the ids we mint to skip repeated
 * `findFile` lookups on every drain. The cache is advisory: bootstrap always
 * tolerates a miss by re-finding or re-creating, so a cleared cache or a
 * user-deleted folder self-heals on the next bootstrap.
 */
import { getDb } from '../store/db'

const TREE_KEY = 'drive:tree'

/** Cached ids for the parts of the tree the upload engine reaches for. */
export interface DriveTree {
  /** timebox/ root folder id. */
  rootId: string
  /** Per-stream folder + fixed-file ids, keyed by stream id. */
  streams: Record<string, StreamTree>
}

export interface StreamTree {
  /** timebox/<stream>/ folder id. */
  folderId: string
  /** timebox/<stream>/log/ folder id. */
  logId: string
  /** timebox/<stream>/results/ folder id. */
  resultsId: string
  /** Date-partition folder ids under log/, keyed by "YYYY-MM-DD". */
  partitions: Record<string, string>
}

export async function getTree(): Promise<DriveTree | undefined> {
  const db = await getDb()
  return (await db.get('meta', TREE_KEY)) as DriveTree | undefined
}

export async function saveTree(tree: DriveTree): Promise<void> {
  const db = await getDb()
  await db.put('meta', tree, TREE_KEY)
}

export async function clearTree(): Promise<void> {
  const db = await getDb()
  await db.delete('meta', TREE_KEY)
}

/** An empty per-stream subtree, before any of its folders are known. */
export function emptyStreamTree(folderId: string, logId: string, resultsId: string): StreamTree {
  return { folderId, logId, resultsId, partitions: {} }
}
