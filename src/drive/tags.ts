/**
 * appProperties tagging for every file/folder the app creates on Drive.
 * Tags are set at creation time (free — part of the create request) and are
 * app-private (`drive.file` appProperties are visible only to this app). They
 * exist to make cold-start discovery a single `files.list` query in the
 * future; today's pull path still discovers by filename (SPEC §8.5), so tags
 * are advisory: files created by older app versions carry none, and no code
 * path may *require* them for correctness.
 */

/** appProperties key: what role the file plays in the timebox/ tree. */
export const TAG_KIND = 'captureKind'
/** appProperties key: which stream the file belongs to (absent on the root/registry). */
export const TAG_STREAM = 'captureStream'

export type TagKind =
  | 'root'
  | 'registry'
  | 'stream'
  | 'log'
  | 'results'
  | 'config'
  | 'checkpoint'
  | 'partition'
  | 'record'
  | 'segment'
  | 'attachment'

/** Build the appProperties for one created file/folder. */
export function tags(kind: TagKind, stream?: string): Record<string, string> {
  return { [TAG_KIND]: kind, ...(stream ? { [TAG_STREAM]: stream } : {}) }
}
