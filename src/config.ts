/**
 * Build-time configuration. The OAuth client ID is a public identifier for a
 * browser (public) client — safe to ship in the bundle (SPEC §9.2).
 *
 * There is no `APP_ORIGIN` constant: the deployed origin isn't something the
 * app reads at runtime (GIS validates the calling origin against the
 * Authorized JavaScript origins configured on the OAuth client in Google
 * Cloud Console, not against a value shipped in the bundle), so a fork only
 * needs to add its real origin there — see README's fork checklist.
 */
export const GOOGLE_CLIENT_ID =
  '1055328792781-3qp3rdol6ebq8idump3610qhebma30f8.apps.googleusercontent.com'

/**
 * External API endpoints (issue #69): the OpenAI-compatible assistant
 * endpoint, consumed by `assistant/config.ts`. The transcription and
 * vision-captioning endpoints are a separate, already-established
 * fork/self-host seam in `src/enrich/config.ts` (issue #62,
 * `TRANSCRIBE_BASE_URL`/`VISION_CHAT_URL`) — kept there rather than
 * duplicated here, since that module also owns the paired model constants
 * and both pipelines' `api.ts` already read from it. Every host across both
 * modules must also be whitelisted in `index.html`'s CSP `connect-src`
 * (pinned by `config.test.ts`).
 */
export const ENDPOINTS = {
  assistant: 'https://llm.elimelt.com/v1',
} as const

/**
 * OAuth scopes the app requests together at connect (SPEC §8.1). They live
 * here — a neutral build-config module — rather than in drive/ or gcal/ so the
 * store can compose them without breaking the §10 layering rule (generic
 * layers must not import gcal/). One combined-scope token therefore authorizes
 * both APIs: file-scoped Drive read/write and read-only Calendar.
 *
 * `drive.file` is non-sensitive; `calendar.readonly` is sensitive but read-only
 * (SPEC §8.1). Adding calendar *write* later is a one-line change here (the app
 * never writes calendar events in v1 — §1.2).
 */
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file'
export const CALENDAR_READONLY_SCOPE = 'https://www.googleapis.com/auth/calendar.readonly'
export const GOOGLE_SCOPES = [DRIVE_SCOPE, CALENDAR_READONLY_SCOPE]
