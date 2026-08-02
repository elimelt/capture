import { useEffect, useState, useSyncExternalStore } from 'react'
import type { Attachment } from '../contract/types'
import { getBlob } from '../store/events'
import { liveTranscripts, type LiveTextStore } from '../store/livetext'
import { MicIcon, cx, motion, tone, type_ } from '../ui'
import { authorship, type Authorship } from './authorship'
import { groupAttachments } from './attachmentGroups'
import { useAudioPlayback } from './useAudioPlayback'
import { TextSheet } from './TextSheet'
import { Waveform } from './Waveform'

interface AttachmentBodyProps {
  attachments: Attachment[]
  /** Replace a text attachment's content (one amend: remove old + add new). */
  onEditText: (oldFile: string, text: string, derivedFrom?: string) => void
}

/**
 * Subscribe to a live-text store; snapshots are immutable maps. Exported so
 * `PhotoGrid` (#102) can subscribe to `liveCaptions` with the same pattern
 * without duplicating the `useSyncExternalStore` wiring.
 */
export function useLiveText(store: LiveTextStore): ReadonlyMap<string, string> {
  return useSyncExternalStore(store.subscribe, store.snapshot)
}

/**
 * Renders an entry's text content and extra audio clips (#78, revised by
 * #102): note/transcript text inline (tap to edit), extra audio clips as
 * playback rows. Always mounted alongside the card's header and photo grid
 * now (#102's "content is always visible" inversion) — no `expanded` gate.
 * Photos (and their removal) moved to `PhotoGrid` (#102: a tight thumbnail
 * grid replaces the old one-thumbnail-per-row layout), so this component
 * only owns text/audio and has no attachment-removal affordance of its own.
 *
 * Authored-vs-generated (#80, revised): only user-typed notes render as
 * the entry's own voice — the heaviest, darkest treatment
 * (`type_.bodyStrong`/`tone.textPrimary`). Machine text — transcripts and
 * captions alike — shares the quiet `type_.derived`/`tone.textDerived`
 * pairing, so anything the app generated reads the same at a glance;
 * a transcript keeps its `SpokenMark` glyph to tell it apart from a
 * caption. Classification is the pure `authorship()` (`authorship.ts`),
 * driven solely by `derivedFrom`; edited transcripts/captions keep their
 * `derivedFrom` link so they are never re-derived and never change class.
 * Grouping/pairing itself is the pure `groupAttachments`.
 *
 * While a transcript is still streaming in from its service, the partial
 * text appears in the same position via the transient `liveTranscripts`
 * store (`src/store/livetext.ts`), keyed by source file — shown only until
 * a persisted attachment derived from that file exists — and adopts the
 * same `'spoken'` authorship treatment as its final form (#80 req. 6).
 * Streaming captions are `PhotoGrid`'s concern now (they render beside
 * their photo, not here).
 */
export function AttachmentBody({ attachments, onEditText }: AttachmentBodyProps) {
  const [edit, setEdit] = useState<
    { file: string; text: string; derivedFrom?: string; authorship: Authorship } | null
  >(null)
  const liveT = useLiveText(liveTranscripts)
  const { transcripts, notes, audio, orphanCaptions } = groupAttachments(attachments)
  // The first clip's waveform appears in the card header; later ones render here.
  const extraAudio = audio.slice(1)
  // Streaming transcripts for sources with no persisted transcript yet.
  // Once the amend lands the stored attachment wins, live text is ignored.
  const derivedSources = new Set(
    attachments.filter((a) => a.kind === 'text' && a.derivedFrom !== undefined).map(
      (a) => a.derivedFrom,
    ),
  )
  const streamingTranscripts = audio
    .filter((a) => !derivedSources.has(a.file))
    .map((a) => ({ file: a.file, text: liveT.get(a.file) }))
    .filter((s): s is { file: string; text: string } => s.text !== undefined && s.text !== '')
  if (
    transcripts.length === 0 &&
    notes.length === 0 &&
    extraAudio.length === 0 &&
    orphanCaptions.length === 0 &&
    streamingTranscripts.length === 0
  ) {
    return null
  }

  return (
    <div className="mt-2 flex flex-col gap-2">
      {transcripts.map((a) => (
        <NoteText key={a.file} attachment={a} onEdit={setEdit} />
      ))}
      {streamingTranscripts.map((s) => (
        <StreamingText key={s.file} text={s.text} authorship="spoken" />
      ))}
      {notes.map((a) => (
        <NoteText key={a.file} attachment={a} onEdit={setEdit} />
      ))}
      {extraAudio.map((a) => (
        <AudioRow key={a.file} file={a.file} durationSec={a.durationSec} />
      ))}
      {orphanCaptions.map((a) => (
        <NoteText key={a.file} attachment={a} onEdit={setEdit} />
      ))}
      {edit && (
        <TextSheet
          title={EDIT_TITLE[edit.authorship]}
          placeholder="Type a note…"
          cta="Save"
          initial={edit.text}
          onSave={(text) => onEditText(edit.file, text, edit.derivedFrom)}
          onClose={() => setEdit(null)}
        />
      )}
    </div>
  )
}

/**
 * Renders inline math ($...$) as styled text. A minimal no-dependency
 * approach per design-nit: "render $P(k)$ as *P(k)*".
 */
export function renderWithMath(text: string): React.ReactNode[] {
  const parts: React.ReactNode[] = []
  let last = 0
  // Simple inline math: $content$ where content has no $ or newlines.
  // Avoids lookbehind for broader browser support.
  const mathRegex = /\$([^$\n]+)\$/g
  let match: RegExpExecArray | null
  while ((match = mathRegex.exec(text)) !== null) {
    // Skip $$ (display math delimiter — leave as-is)
    if (match.index > 0 && text[match.index - 1] === '$') continue
    if (match.index + match[0].length < text.length && text[match.index + match[0].length] === '$')
      continue
    if (match.index > last) {
      parts.push(text.slice(last, match.index))
    }
    parts.push(
      // Renders upright (not-italic) within whatever serif/tone the caller's
      // NoteText/StreamingText span already applies (#85) — no separate
      // font-family class needed here.
      <em key={match.index} className="not-italic">
        {match[1]}
      </em>,
    )
    last = match.index + match[0].length
  }
  if (last < text.length) {
    parts.push(text.slice(last))
  }
  return parts.length > 0 ? parts : [text]
}

/**
 * Authored-vs-generated token composition (#80, revised): authored notes
 * keep the heaviest, darkest treatment — the user's own typed words — while
 * all machine text (spoken transcripts and derived captions alike) renders
 * in the quiet `type_.derived`/`tone.textDerived` pairing, so transcribed
 * text is visibly distinct from written text; the `SpokenMark` glyph still
 * marks a transcript as speech rather than inference. Never key this off
 * text content or attachment kind directly; always go through
 * `authorship()` (`authorship.ts`), which is the single place the
 * `derivedFrom` contract is interpreted. Exported so `PhotoGrid` (#102)
 * composes the same tokens for in-grid captions rather than re-deriving them.
 */
export const AUTHORSHIP_STYLE: Record<Authorship, string> = {
  authored: cx(type_.bodyStrong, tone.textPrimary),
  spoken: cx(type_.derived, tone.textDerived),
  derived: cx(type_.derived, tone.textDerived),
}

/** The `TextSheet` edit title per class (#80 req. 5) — kept in one place so
 *  every edit affordance (inline `NoteText`, `PhotoGrid`'s caption tap)
 *  agrees with the classifier. */
export const EDIT_TITLE: Record<Authorship, string> = {
  authored: 'Edit note',
  spoken: 'Edit transcript',
  derived: 'Edit caption',
}

/**
 * The quiet marker for `'spoken'` text (#80 req. 2): a small muted mic
 * glyph — never bold, never a competing text block — noting the text was
 * transcribed from speech; with transcripts now sharing the caption's
 * derived styling, it is what tells a transcript apart from a caption.
 * `aria-hidden`: the surrounding control's "Edit transcript" label already
 * carries the distinction for screen readers.
 */
export function SpokenMark() {
  return (
    <span
      aria-hidden="true"
      className={cx('mr-1 inline-flex -translate-y-px align-middle', tone.textFaint)}
    >
      <MicIcon size={11} />
    </span>
  )
}

/**
 * A transcript or caption still streaming in: rendered exactly like the
 * final NoteText (same tokens, same position, same `SpokenMark` for
 * `'spoken'`) but read-only — there is nothing to edit until the amend
 * lands — with a pulsing cursor tick. Exported so `PhotoGrid` (#102) can
 * render a streaming caption beside its photo with the same treatment.
 */
export function StreamingText({ text, authorship: a }: { text: string; authorship: Authorship }) {
  return (
    <span
      aria-live="polite"
      className={cx(
        'block whitespace-pre-wrap break-words text-left',
        motion.fadeIn,
        AUTHORSHIP_STYLE[a],
      )}
    >
      {a === 'spoken' && <SpokenMark />}
      {renderWithMath(text)}
      <span
        aria-hidden="true"
        className="ml-0.5 inline-block h-[1em] w-0.5 translate-y-[0.15em] animate-pulse rounded-full bg-current"
      />
    </span>
  )
}

function NoteText({
  attachment,
  onEdit,
}: {
  attachment: Attachment
  onEdit: (target: { file: string; text: string; derivedFrom?: string; authorship: Authorship }) => void
}) {
  const { file, derivedFrom } = attachment
  const a = authorship(attachment)
  const [text, setText] = useState<string | null>(null)
  useEffect(() => {
    let stale = false
    void getBlob(file).then(async (blob) => {
      if (blob && !stale) setText(await blob.text())
    })
    return () => {
      stale = true
    }
  }, [file])
  if (text === null) return null
  return (
    <button
      onClick={() => onEdit({ file, text, derivedFrom, authorship: a })}
      aria-label={EDIT_TITLE[a]}
      className={cx('text-left', motion.fadeIn)}
    >
      <span className={cx('block whitespace-pre-wrap break-words', AUTHORSHIP_STYLE[a])}>
        {a === 'spoken' && <SpokenMark />}
        {renderWithMath(text)}
      </span>
    </button>
  )
}

/**
 * Playback row for an entry's second and later clips. Carries the same
 * waveform fingerprint (#86) as the card header's primary clip so the
 * signature reads consistently wherever an entry's audio appears.
 */
function AudioRow({ file, durationSec }: { file: string; durationSec?: number }) {
  const playback = useAudioPlayback(file)
  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        aria-label={playback.playing ? 'Stop playback' : 'Play recording'}
        onClick={() => void playback.toggle()}
        className="shrink-0 rounded-md"
      >
        <Waveform file={file} progress={playback.progress} className="w-16" />
      </button>
      <span className={cx('tabular-nums', type_.caption, tone.textFaint)}>
        Recording{durationSec !== undefined ? ` · ${durationSec}s` : ''}
      </span>
    </div>
  )
}
