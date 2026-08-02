/**
 * Design tokens — the single place visual identity lives. Components in
 * src/ui/ compose these; screens never hardcode palette classes. A future
 * design pass edits this file (and the primitives), not the screens.
 *
 * Warm Editorial Slate: serif (Libertinus) for content the user reads,
 * system sans for UI chrome. The split is deliberate — editorial content
 * in a native-feeling shell. Palette lives in src/index.css @theme.
 */

export const tone = {
  /** App background. */
  bg: 'bg-paper dark:bg-paper-dark',
  /** Raised surfaces: cards, sheets, nav. */
  surface: 'bg-card dark:bg-card-dark',
  /** Sunken/inset surfaces: inputs, wells. */
  sunken: 'bg-well dark:bg-well-dark',
  /** Hairline borders on surfaces. */
  border: 'border-line dark:border-line-dark',
  /** Stronger borders: inputs, secondary buttons. */
  borderStrong: 'border-line-strong dark:border-line-strong-dark',

  textPrimary: 'text-ink dark:text-ink-dark',
  textSecondary: 'text-ink-secondary dark:text-ink-secondary-dark',
  textMuted: 'text-ink-muted dark:text-ink-muted-dark',
  textFaint: 'text-ink-faint dark:text-ink-faint-dark',
  /**
   * Paired with `type_.derived` (#80): machine-inferred/generated content —
   * photo captions, related-memory snippets, generated day prose. Same hue
   * as `textMuted` (quiet, not the faintest ramp) but named for what it
   * means at the call site — authored-vs-generated, not just "muted" for
   * some other reason — so intent stays legible. Compose the two together,
   * never apart; see `src/capture/authorship.ts`.
   */
  textDerived: 'text-ink-muted dark:text-ink-muted-dark',

  accent: 'text-spruce dark:text-spruce-dark',
  accentBg: 'bg-spruce dark:bg-spruce-dark',
  accentBgActive: 'active:bg-spruce-deep dark:active:bg-spruce-deep-dark',
  /** Subtle spruce-tinted fill. */
  accentWash: 'bg-spruce-wash dark:bg-spruce-wash-dark',

  danger: 'text-clay-deep dark:text-clay-dark',
  dangerBg: 'bg-clay',
  dangerBgActive: 'active:bg-clay-deep',
  /** Subtle clay-tinted fill. */
  dangerWash: 'bg-clay-wash dark:bg-clay-wash-dark',

  /** Pressed-state wash for bordered/ghost controls. */
  pressWash: 'active:bg-well dark:active:bg-well-dark',
} as const

export const shape = {
  card: 'rounded-[14px]',
  control: 'rounded-xl',
  pill: 'rounded-full',
} as const

export const type_ = {
  /** Screen titles — the editorial voice. */
  title: 'font-serif text-[26px] font-semibold leading-tight tracking-[-0.01em]',
  /** Section headings. */
  heading: 'font-serif text-[17px] font-semibold leading-snug',
  /** Primary reading content: entries, notes. */
  body: 'font-serif text-[16px] leading-normal',
  /** Main entry text — transcripts and notes, rendered in full (#102: content
   *  is never clamped/hidden). A step up from `body` so the entry's own
   *  words lead the card over descriptive metadata. `leading-snug` (not
   *  `leading-normal`) so it reads as a compact fragment of speech rather
   *  than a roomy headline (#85), even at full, unclamped length. */
  bodyStrong: 'font-serif text-[17px] font-medium leading-snug',
  /** Secondary descriptive content: photo captions and similar derived text. */
  bodySmall: 'font-serif text-[14px] leading-normal',
  /**
   * Machine-inferred/generated text (#80): photo captions, AI-derived
   * attachments, generated day prose, related-memory snippets — never
   * bolder than authored/spoken text (`bodyStrong`). Still content the
   * user reads (serif, #85's split), but italic marks it as the app's
   * inference rather than the user's own words. Pairs with
   * `tone.textDerived`; compose the two together, never apart. See
   * `src/capture/authorship.ts` for the classification that decides when
   * this applies.
   */
  derived: 'font-serif text-[14px] italic leading-normal',
  /** Functional secondary: subtitles, labels. */
  sub: 'font-sans text-[13px] leading-snug',
  /** Timestamps, metadata. */
  caption: 'font-sans text-[12px] leading-snug',
  /** Tiny uppercase section labels. */
  overline: 'font-sans text-[11px] font-medium uppercase tracking-[0.08em]',
  /** Buttons and controls — chrome, never serif. */
  ui: 'font-sans text-[15px] leading-snug',
} as const

/** Entrance animations (keyframes live in src/index.css @theme). */
export const motion = {
  /** Backdrops, screens, content that arrives asynchronously. */
  fadeIn: 'animate-fade-in',
  /** Cards and list items. */
  riseIn: 'animate-rise-in',
  /** Panels that replace controls in place; modal content. */
  scaleIn: 'animate-scale-in',
  /** Bottom sheets. */
  sheetIn: 'animate-sheet-in',
  /** Toasts. */
  toastIn: 'animate-toast-in',
  /**
   * The one continuous (non-entrance) animation: the sweeping fill of an
   * indeterminate `ProgressBar` (a phase with no known total, e.g. a sync
   * pull). Like every other `motion` token, `prefers-reduced-motion: reduce`
   * (src/index.css) collapses its duration to ~0 — the bar goes static
   * instead of moving, rather than being hidden.
   */
  indeterminate: 'animate-sync-sweep',
} as const

/**
 * Fixed/sticky stacking strata — the app's single z-index scale. The order
 * is the contract: nav (tab bar, sticky screen chrome) < raised (toasts,
 * fixed composers) < overlay (sheet backdrops, sheets, fullscreen viewers).
 * New fixed-position UI picks a stratum here; never hardcode a z-* class.
 * (The boot splash in index.html sits above everything at z 100.)
 *
 * Overlays must also mount via OverlayPortal (src/ui/Sheet.tsx): entrance
 * animations run with fill `both`, which keeps screens and cards permanent
 * stacking contexts, so an overlay rendered in place would be trapped
 * beneath the later-in-DOM tab bar no matter how high its z-index.
 */
export const layer = {
  /** App chrome: bottom tab bar, sticky screen headers. */
  nav: 'z-30',
  /** Above chrome, below overlays: toasts, fixed chat composer. */
  raised: 'z-40',
  /** Modal layers: sheet backdrop + sheet, fullscreen photo/map viewers. */
  overlay: 'z-50',
} as const

/** Minimum tap target (Apple HIG 44pt). */
export const tap = 'min-h-11 min-w-11'

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ')
}
