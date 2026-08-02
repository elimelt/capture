# Inline plain-text context

`src/context/plainText.ts` renders folded entries as portable Markdown/plaintext.
Every text attachment is labeled by provenance: `Note` for user-authored text,
`Voice transcript` for text derived from audio, and `Image description` for text
derived from a photo. Each entry includes its captured wall-clock timestamp, the
numeric UTC offset, device IANA timezone, location, and media counts/durations.
Each visible attachment also carries the append timestamp of the capture or amend
event that added it, so recordings, photos, notes, transcripts, and descriptions
retain their own timing in copied context.

The renderer reads only the entry's text blobs from IndexedDB through an injected
`getBlob` function. `src/context/clipboard.ts` copies the result locally using
the Clipboard API with an off-screen textarea fallback for older Safari/PWA
contexts. Entry cards expose `Copy entry`; the Day screen exposes `Copy day` and
passes the same representation through to each entry. Nothing is sent over the
network.
