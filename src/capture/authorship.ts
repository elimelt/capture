/**
 * Pure authored-vs-generated classification (#80): the visual axis the
 * design review asked for — "the user should immediately know what they
 * said vs what the app inferred" — driven **solely** by the existing
 * `derivedFrom` contract on attachments (SPEC §3.3: absent = user-created).
 * No new stored state, no heuristics on text content. No I/O, no React;
 * tested directly (`authorship.test.ts`, no jsdom).
 */
import type { Attachment } from '../contract/types'
import { isCaption } from '../vision/plan'

/**
 * - `'authored'`: user-typed text (no `derivedFrom`) — the user's own words.
 * - `'spoken'`: text derived from audio (a transcript). A transcript IS
 *   machine-derived, but it represents what the user *said* — decision
 *   recorded on #80/#89: it renders as authored voice (heaviest, darkest),
 *   with a quiet marker noting it was transcribed, never as machine
 *   inference.
 * - `'derived'`: machine inference over the entry's content — photo
 *   captions today, any future derived text (SPEC §3.3's `derivedFrom`
 *   covers any sibling attachment, not just photos) — lighter, never
 *   bolder than authored/spoken text.
 */
export type Authorship = 'authored' | 'spoken' | 'derived'

/**
 * Classifies one attachment along the authored-vs-generated axis. Depends
 * only on `derivedFrom`/`kind` (via `isCaption`) — never on the attachment's
 * text content — so two attachments with identical bodies but different
 * `derivedFrom` always classify differently, and an edited transcript/
 * caption (which preserves `derivedFrom`, per the existing `onEditText`
 * invariant) never changes class.
 */
export function authorship(a: Attachment): Authorship {
  if (a.derivedFrom === undefined) return 'authored'
  return isCaption(a) ? 'derived' : 'spoken'
}
