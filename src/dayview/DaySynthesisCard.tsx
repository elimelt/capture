/**
 * The Day-as-reward-loop artifact (#82): the deterministic stat line (always
 * on, local-only) plus, only when the AI opt-in is enabled, an explicit
 * "Generate summary" tap for a one-to-two-sentence prose recap. Renders
 * between ScreenHeader and DayTimeline in DayScreen.tsx.
 *
 * The prose is generated, not authored: it renders in the quiet
 * derived-content treatment (`type_.derived`/`tone.textDerived` — #80's
 * authored-vs-generated pairing for machine inference) and is never
 * editable — regenerate replaces it wholesale via a new tap, there is no
 * inline edit affordance.
 */
import { Button, Card, cx, tone, type_ } from '../ui'
import type { UseDaySynthesisResult } from './useDaySynthesis'

export interface DaySynthesisCardProps {
  synthesis: UseDaySynthesisResult
  /** The global AI opt-in (`appSettings.assistantEnabled`) — the "Generate
   *  summary" affordance does not render at all when this is false, so
   *  nothing about the feature is even visible until the user opts in. */
  assistantEnabled: boolean
}

export function DaySynthesisCard({ synthesis, assistantEnabled }: DaySynthesisCardProps) {
  const { stat, prose, proseState, canGenerate, generate } = synthesis
  if (!stat.statLine) return null

  return (
    <Card>
      <p className={cx(type_.heading, tone.textPrimary)}>{stat.statLine}</p>

      {assistantEnabled && (
        <div className="mt-3 flex flex-col gap-2">
          {prose && <p className={cx(type_.derived, tone.textDerived)}>{prose}</p>}
          {proseState === 'error' && (
            <p className={cx(type_.caption, tone.textFaint)}>
              Summary generation failed — the stat line above still stands.
            </p>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="self-start"
            disabled={!canGenerate}
            onClick={generate}
          >
            {proseState === 'loading'
              ? 'Generating…'
              : prose
                ? 'Regenerate summary'
                : 'Generate summary'}
          </Button>
        </div>
      )}
    </Card>
  )
}
