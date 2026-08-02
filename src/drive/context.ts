/**
 * Maintains the app-owned, human/agent-readable context export at
 * `timebox/context.md`. It is a mutable projection of the folded timelog, not
 * part of the append-only log and not imported by the pull path.
 */
import { formatEntriesPlainText } from '../context/plainText'
import { getBlob, listEntries } from '../store/events'
import { TIMELOG_STREAM } from '../streams/registry'
import { findFile, updateFileContent, uploadFile } from './client'
import { tags } from './tags'
import { getTree } from './tree'

export const CONTEXT_FILE_NAME = 'context.md'
export const CONTEXT_MIME_TYPE = 'text/markdown'

/** Rebuild and overwrite the stable Drive context file from local folded state. */
export async function syncContextFile(token: string): Promise<void> {
  const tree = await getTree()
  // A mocked or system-only cycle may not bootstrap the capture tree. There is
  // no context to write in that case; the next cycle that reaches timelog will
  // create/update the projection.
  if (!tree) return

  const entries = await listEntries(TIMELOG_STREAM.id)
  const body = await formatEntriesPlainText(entries, getBlob)
  const fileId = await findFile(token, { name: CONTEXT_FILE_NAME, parentId: tree.rootId })
  if (fileId) {
    await updateFileContent(token, fileId, CONTEXT_MIME_TYPE, body)
    return
  }
  await uploadFile(token, {
    name: CONTEXT_FILE_NAME,
    parentId: tree.rootId,
    mimeType: CONTEXT_MIME_TYPE,
    body,
    appProperties: tags('context'),
  })
}
