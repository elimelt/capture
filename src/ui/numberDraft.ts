/**
 * Draft-state helpers for numeric picker fields (used by Settings and the
 * place sheets). Numeric inputs keep their in-progress value as a string so
 * empty and partial input stay representable while typing — the field never
 * snaps back to a number mid-edit. Validation and min/max clamping happen
 * only at the commit boundary (Save tap or blur), never per keystroke.
 */

/** Parse a draft string to a finite number; `undefined` when empty or invalid. */
export function parseNumericDraft(draft: string): number | undefined {
  const trimmed = draft.trim()
  if (trimmed === '') return undefined
  const n = Number(trimmed)
  return Number.isFinite(n) ? n : undefined
}

/** True when the draft can be committed — empty/invalid stays draft-only. */
export function canCommitNumericDraft(draft: string): boolean {
  return parseNumericDraft(draft) !== undefined
}

/**
 * Commit a draft: round to a whole number and clamp into [min, max].
 * Returns `undefined` when the draft is empty/invalid — callers skip the
 * commit (or disable Save via `canCommitNumericDraft`).
 */
export function commitNumericDraft(
  draft: string,
  min: number,
  max = Infinity,
): number | undefined {
  const n = parseNumericDraft(draft)
  if (n === undefined) return undefined
  return Math.min(max, Math.max(min, Math.round(n)))
}
