/**
 * Build-time configuration. The OAuth client ID is a public identifier for a
 * browser (public) client — safe to ship in the bundle (SPEC §9.2).
 */
export const GOOGLE_CLIENT_ID =
  '1055328792781-3qp3rdol6ebq8idump3610qhebma30f8.apps.googleusercontent.com'

export const APP_ORIGIN = 'https://time.elimelt.com'

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
