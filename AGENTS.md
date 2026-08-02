# AGENTS.md — guide for AI coding agents

Capture is a mobile-first, offline-first PWA (TypeScript + React, built with
Vite) for voice-first activity capture, with Google Drive as the sync
substrate. Read [CONTRIBUTING.md](CONTRIBUTING.md) and
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) before making non-trivial changes.

## Routine operations

Prerequisites: Node.js (CI uses Node 24) and npm.

```sh
npm install                # or `npm ci` for a clean install
npm run dev                # Vite dev server
npm test                   # vitest run — hermetic unit tests, no network
npm run test:watch         # vitest in watch mode
npm run test:integration   # VITEST_INTEGRATION=1 — hits live LLM endpoint
npm run lint               # oxlint
npm run build              # tsc -b (type-check both projects) && vite build
npm run preview            # serve the production build locally
```

- The default suite must stay hermetic. The one network-dependent test
  (`src/assistant/transport.integration.test.ts`) is excluded unless
  `VITEST_INTEGRATION=1`; run it only when touching the assistant transport
  and network access is available.
- **CI:** every pull request and push to `main` runs
  `.github/workflows/ci.yml` (`npm ci`, `npm test`, `npx tsc -b`,
  `npm run lint`, `npm run build`).
- **Deploy model:** every push to `main` triggers
  `.github/workflows/deploy.yml`, which runs `npm ci`, `npm test`,
  `npm run build`, then deploys to GitHub Pages. Never push to `main` with
  failing tests — a push is a deploy.

### Always open a PR

- **Never push directly to `main`.** Every change — code or docs — goes on a
  branch and is submitted as a pull request (`gh pr create --base main`), so
  changes get CI and a review point before they deploy.
- Branch names: `feat/…`, `fix/…`, or `docs/…` as appropriate.
- A PR must be green (tests, lint, build) and self-contained: code, tests,
  and the doc updates required by the policy below land in the same PR.

### Git workflow notes

- **Worktrees are in use.** `main` and other branches may be checked out in
  sibling worktrees (`git worktree list`), so they can't be checked out here.
  To work on another branch without touching the user's working tree, use a
  throwaway worktree under `.worktrees/` (gitignored), e.g.
  `git worktree add --detach .worktrees/<name> origin/main`, and
  `git worktree remove` it when done.
- **PRs are squash-merged.** After a merge, the branch's commits are not
  ancestors of `main`, so `git branch -d` refuses with "not fully merged".
  Verify the merge (`gh pr list --state merged --head <branch>`) before using
  `git branch -D`. Prune periodically: `git fetch --prune`, then delete local
  branches marked `[gone]` in `git branch -vv`.

### Before any commit

- Run `npm test` and `npm run lint` (and `npm run build` for type-checking
  changes). `src/layering.test.ts` must pass — it mechanically enforces the
  layering rule and fails the suite on forbidden imports.
- No new runtime dependencies without prior discussion; the dependency list is
  deliberately small.
- Any new external network endpoint must be added to the Content-Security-Policy
  in `index.html`.
- Any behavior change needs a test; prefer testing pure cores (fold, plans,
  serializers) directly.

## Documentation maintenance policy

The `docs/` tree is load-bearing (for contributors and external Drive-reading
skills) and must stay in sync with the code.

### Module → doc map

| Source | Module doc |
| --- | --- |
| `src/contract/`, `src/streams/` | `docs/modules/contract-and-streams.md` |
| `src/store/` | `docs/modules/store.md` |
| `src/drive/` | `docs/modules/drive.md` |
| `src/capture/`, `src/dayview/` | `docs/modules/capture-and-dayview.md` |
| `src/assistant/` | `docs/modules/assistant.md` |
| `src/transcribe/`, `src/vision/`, `src/places/` | `docs/modules/pipelines-and-places.md` |
| `src/ui/`, `src/settings/`, app shell & tooling | `docs/modules/app-shell-ui-and-tooling.md` |
| `src/gcal/` | `docs/modules/gcal.md` |

### Rules

- Changing behavior or exports in a module → update its module doc in the
  same PR.
- Changing a cross-module flow → update the relevant
  `docs/subsystems/*.md` (`data-and-sync.md`, `ai-and-enrichment.md`,
  `app-and-ui.md`).
- Changing architecture, layering, or build/deploy → update
  `docs/ARCHITECTURE.md`.
- Adding a new `src/` module → create `docs/modules/<name>.md`, add it to
  the map in `docs/ARCHITECTURE.md`, and add it to README's documentation map.
- Keep `README.md` (commands, configuration, doc links) and
  `CONTRIBUTING.md` accurate as commands or workflows change.
- `SPEC.md` is the product spec and Drive file contract. Source code wins
  where they diverge; note or fix material divergence in `SPEC.md`.

## Key architecture rules (must respect)

Details in [CONTRIBUTING.md](CONTRIBUTING.md) and
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md); summarized:

- **Append-only log.** Streams are immutable logs of `capture.event.v1`
  events with exactly three types: `capture` creates, `amend` patches,
  `revoke` hides. Never mutate or delete events in place; read state is
  always `fold(events)` (`src/contract/fold.ts`).
- **Single write path.** All writes go through `useAppStore` actions and
  `src/store/events.ts` — the only writer of the local log. Never write to
  IndexedDB or append events elsewhere.
- **Manual sync only.** Drive sync (one pull-then-push cycle via `drainSync`)
  runs only from the "Sync now" button in Settings — never on capture, init,
  connect, foreground, or `online` events. Do not add automatic sync triggers.
  Out-of-sync state is surfaced in Settings (pending/failed counts +
  `lastSyncAt`, stamped only after a clean cycle).
- **Byte-stable serialization.** `src/contract/serialize.ts` output is a
  contract shared with external Drive-reading skills (fixed key order,
  2-space indent, trailing newline, optional fields omitted). Changing it is
  a contract change; see the golden-file tests in
  `src/contract/serialize.test.ts`.
- **Layering rule.** Generic layers (`streams/`, `capture/`, `contract/`,
  `store/`, `places/`, `drive/`, `transcribe/`, `vision/`, `ui/`) must not
  import from `gcal/`, `dayview/`, `settings/`, or `assistant/`. Enforced by
  `src/layering.test.ts`.
- **Tokens-only palette in screens.** Screens never hardcode palette or
  shape classes; all styling flows through `src/ui/tokens.ts` and the `src/ui`
  primitives, with raw colors only in `src/index.css` `@theme`.
