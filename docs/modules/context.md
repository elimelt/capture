# Context export

The Context screen (`src/context/ContextScreen.tsx`) provides a portable view of
the folded local log at `/context`. It defaults to the last seven local calendar
days and supports Today, Yesterday, This week, or a custom inclusive date range.

The screen reads visible entries from the Zustand store and text attachment blobs
from IndexedDB, then renders a Markdown/plaintext preview. `src/context/export.ts`
contains the pure `formatContext` function: entries are grouped by local day and
include wall-clock time, place, note/transcript text, and audio/photo counts.
The Copy context action uses the Clipboard API when available and an off-screen
textarea fallback for older Safari/PWA contexts. No data is sent over the network.
