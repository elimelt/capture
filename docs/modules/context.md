# Inline plain-text context

`src/context/plainText.ts` renders folded entries as portable Markdown/plaintext.
Every text attachment is labeled by provenance: `Note` for user-authored text,
`Voice transcript` for text derived from audio, and `Image description` for text
derived from a photo. Each entry has one compact header with its ID, captured
wall-clock timestamp, and device IANA timezone/UTC offset, followed by location
and a single timestamp-ordered attachment timeline. Audio, photos, notes,
transcripts, and descriptions each retain the append timestamp from the capture
or amend event that added them; derived text also identifies its source time.
Full-day exports add the date, entry count, and shared timezone once instead of
repeating it on every entry.

The renderer reads only the entry's text blobs from IndexedDB through an injected
`getBlob` function. `src/context/clipboard.ts` copies the result locally using
the Clipboard API with an off-screen textarea fallback for older Safari/PWA
contexts. Entry cards expose `Copy entry`; the Day screen exposes `Copy day` and
passes the same representation through to each entry. Nothing is sent over the
network.
