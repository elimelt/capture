# Contributing to Capture

Capture is a mobile-first, offline-first PWA (TypeScript + React) for voice-first
capture with Google Drive as the sync substrate. Before contributing, read
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — it is short and explains the design
decisions this guide asks you to preserve. `SPEC.md` holds product intent and the
Drive file contract (source code wins where they disagree).

## Development setup

Prerequisites: Node.js (CI uses Node 24) and npm.

```sh
npm ci               # install dependencies
npm run dev          # Vite dev server
npm test             # vitest run (hermetic unit tests)
npm run lint         # oxlint
npm run build        # tsc -b (type-check both projects) && vite build
npm run preview      # serve the production build locally
```

## Repository layout

| Directory | Role |
| --- | --- |
| `src/contract/` | Event schema, fold, filenames, byte-stable wire format. Depends on nothing else in `src/`. |
| `src/streams/` | Registry of capture profiles (v1 ships only `timelog`). |
| `src/store/` | IndexedDB repositories (events, places, settings) and the single Zustand `appStore`. |
| `src/drive/` | GIS auth, Drive client, tree bootstrap, upload queue, pull engine. |
| `src/gcal/` | Read-only Google Calendar client + target-calendar config (timelog read-back; feeds the Day view). |
| `src/transcribe/`, `src/vision/`, `src/places/` | Post-capture enrichment pipelines. |
| `src/capture/`, `src/dayview/`, `src/settings/`, `src/assistant/` | The four screens. |
| `src/ui/` | Design system: tokens + primitives. The only place visual identity lives. |
| `src/App.tsx`, `src/main.tsx` | Routing, tab bar, app-level lifecycle, boot. |

Subsystem and module docs live in `docs/subsystems/` and `docs/modules/`.

## Architecture rules (must follow)

**Layering.** The generic layers — `streams/`, `capture/`, `contract/`, `store/`,
`places/`, `drive/`, `transcribe/`, `vision/`, `ui/` — are stream-agnostic and must
not import from the timelog-specific or app-level directories `gcal/`, `dayview/`,
`settings/`, or `assistant/`. This is enforced by `src/layering.test.ts`, which
scans every source file in the generic layers and fails on forbidden imports. If
you add a new generic layer, add it to the test's glob list and
`LAYERS_EXPECTED_TODAY`.

**Append-only log.** Every stream is an immutable log of `capture.event.v1` events
with exactly three types: `capture` creates, `amend` patches, `revoke` hides.
Never mutate or delete an event in place — "edit" and "delete" are new events
referencing earlier ids. Read state is always derived via `fold(events)`
(`src/contract/fold.ts`), which is deterministic and tolerant of arrival order.
Identity is the event `id`; `seq` is a per-device ordering hint that can collide
across devices — order everything through `compareEvents` (`seq` → `loggedAt` →
`id`) and never key anything by `[stream, seq]`.

**Byte-stable serialization.** `serializeEvent` (`src/contract/serialize.ts`)
produces deterministic JSON: fixed key order, 2-space indent, trailing newline,
optional fields omitted (never `null`). External Drive-reading skills compute
state from these exact bytes. Do not change serialization output without treating
it as a contract change (see golden-file tests in `src/contract/serialize.test.ts`).

**Store is the single write path.** All writes go through `useAppStore` actions
(wrapped in `guard`, which routes failures to the global error toast) and the
event repository in `src/store/events.ts` — the only writer of the local log
(`append` for locally-minted events, `importEvents` for events pulled from
Drive). A local append is one atomic IndexedDB transaction (seq counter + event +
blobs + sync row), and so is an import. Do not write to IndexedDB or append
events from anywhere else.

**UI styling.** Screens never hardcode palette or shape classes. All visual
styling flows through `src/ui/tokens.ts` (`tone`, `shape`, `type_`, `motion`,
`tap`) and the primitives in `src/ui/`; raw color values live only in
`src/index.css` `@theme`.

## Testing

- Unit tests are colocated with their sources (`*.test.ts` throughout `src/`) and
  run with Vitest in a node environment. Run `npm test` before submitting — CI
  runs it before every deploy, and `layering.test.ts` will fail the suite on
  architecture violations.
- The one network-dependent test (`src/assistant/transport.integration.test.ts`)
  is excluded by default; run it with `npm run test:integration` (which sets
  `VITEST_INTEGRATION=1`) only when you touch the assistant transport and have
  network access. The default suite must stay hermetic.
- Any behavior change needs a test. Prefer testing the pure core (fold, plans,
  serializers) directly; `fake-indexeddb` is available for store-level tests.
- Note: `tsconfig.app.json` deliberately excludes node types, so tests under
  `src/` must not import `node:*` modules (see `layering.test.ts`'s
  `import.meta.glob` approach for reading files).

## Code style

- TypeScript strict mode with `noUnusedLocals`/`noUnusedParameters`,
  `verbatimModuleSyntax`. `npm run build` type-checks both tsconfig projects.
- Keep logic in small pure functions where possible — `contract/fold.ts` and the
  pipeline `plan.ts` modules are the model: pure functions over event history,
  heavily unit-tested, no I/O.
- Each module carries a top-of-file doc comment explaining its role and citing
  the relevant SPEC section; match that convention.
- No new runtime dependencies without prior discussion. The dependency list is
  deliberately small, and every new network endpoint must be added to the CSP in
  `index.html`.

## How to add common things

**A new UI screen.** Add a route in `src/App.tsx`'s flat route table and, if
top-level, a tab bar entry. Compose `src/ui` primitives and tokens — no hardcoded
palette classes. Drill-downs are modal sheets (`Sheet`), not routes. Read state
from the store's folded entries; write only through store actions. Preserve the
iOS invariants (safe areas, 44 pt tap targets, keyboard insets).

**A new enrichment pipeline.** Follow the plan/api/runner pattern in
`src/transcribe/` and `src/vision/`: a pure `plan.ts` over the raw event history
decides what still needs work (use `derivedFrom` on attachments as the
machine/user boundary so user edits are never regenerated over); a single
`api.ts` function calls the external service; a `runner.ts` appends results as
ordinary `amend` events — the normal queue syncs them, so no pipeline-specific
sync code. Return immediately when `!navigator.onLine`, back off on transient
failures, skip-mark permanent ones, and never surface errors to the UI. Hook the
drain into `App.tsx`'s existing triggers.

**A new event field.** The event schema is a versioned contract
(`capture.event.v1`) shared with external Drive-reading skills — proceed with
caution. Update `src/contract/types.ts`, `serialize.ts` (fixed key order,
optional fields omitted), `parseEvent` validation, and `fold.ts` if the field
affects derived state; extend the golden-file tests in `serialize.test.ts`; and
update SPEC §5. Fields must be backward-compatible (optional, tolerated by old
readers); anything else means a schema version bump.

## Pull requests

- Keep changes small and focused; one concern per PR.
- Run `npm test`, `npm run lint`, and `npm run build` locally first.
- When behavior changes, update `SPEC.md` and the relevant `docs/` pages in the
  same PR — the docs are load-bearing for contributors and external skills.
- Pushes to `main` deploy automatically to GitHub Pages after tests pass.
