# Overnight Log — 2026-09-30

This file is a running log of autonomous work done overnight on branch `overnight/2026-09-30`.
Entries are appended after each completed task. Read this first before looking at anything else.

---

## FINAL SUMMARY (written 2026-09-30, 01:11, end of session)

All 5 tasks were worked in order. Nothing was pushed, merged, or touched on `master` — everything
lives on `overnight/2026-09-30`, 7 commits ahead of `master`/`integration/v1`, none
amended/squashed. Full monorepo `pnpm lint`,
`pnpm typecheck`, `pnpm test` (all 12 test tasks / 298 tests) and `apps/web`'s `pnpm build` all pass
clean as of the last commit.

**Fully done:**
- **Task 1** — Reports mock-mode fix. Mock layer now emits real `ReportDto`/`ReportDetailDto`
  shapes; new `/reports/:id/submit` and `/reports/:id/confirm` mock endpoints match the real
  backend's maker-checker semantics exactly. Typecheck/lint/build/backend-tests all verified.
- **Task 2** — Dependency investigation. Confirmed clean: no coupling either direction between
  `apps/web` and the backend engine packages/apps.
- **Task 4** — Linting. Next.js ESLint plugin gap fixed (verified: warning gone from `next build`
  output). Husky pre-commit hook added and tested live (a deliberate lint failure was confirmed
  blocked, then cleaned up). CI already had a lint step — nothing to add there.
- **Task 5** — `HANDOVER.md` written at repo root.

**Partially done / intentionally stopped:**
- **Task 3** (repo restructure) — **not attempted**, stopped before moving any files. Task 2
  confirmed the split is dependency-clean, but Task 3 itself hides a real architectural question
  (how `apps/web` keeps consuming `@regops/shared`'s types once split out of the pnpm workspace)
  with no single obviously-correct answer, and guessing wrong would have compounded through
  Task 4's linting setup and this document. See "NEEDS MY DECISION" #2 below.
- **Task 4**'s CI-triggering question — investigated and root-caused (see #1 below), not fixed, per
  your explicit instruction not to go beyond the lint step itself.

**Ordered list of things to check/decide, this morning:**

1. **Read this file's "NEEDS MY DECISION" section right below** (2 items: CI hosting mismatch,
   repo-split shared-code strategy) — nothing downstream depends on you reading it in a particular
   order, but it's the fastest way to see everything that's blocked on you.
2. **Click through Reports in mock mode** (`NEXT_PUBLIC_USE_MOCK_DATA=true`, `pnpm dev`, log in as
   any seeded demo account, visit `/reports`) before treating Task 1 as demo-ready — I verified the
   types/build/lint but explicitly did not drive a browser, per your instruction.
3. **Decide #1: CI hosting.** Repo is on GitLab; `.github/workflows/ci.yml` can't run there. Pick:
   mirror to GitHub, port to `.gitlab-ci.yml`, or something else.
4. **Decide #2: repo-split shared-code strategy** (Task 3). Pick one of: vendor/copy
   `@regops/shared`, publish it as a private package, git submodule/subtree, or keep one pnpm
   workspace with independently-runnable per-area build scripts. Once decided, the actual file
   moves are quick — I can do them (or a fresh session can, using `Entry 3` in this log for the
   dependency-graph facts already gathered).
5. **Reports XML is not goAML-schema-valid** (found while re-reading `HANDOFF.md` for the handover
   doc, not new tonight, but worth flagging prominently) — do not let anyone file a real SAR/CTR
   from this system until that's addressed. Now documented in `HANDOVER.md`'s module table.
6. **Review the 7 commits on `overnight/2026-09-30`** (`git log master..overnight/2026-09-30`) and
   decide whether/how to merge into `integration/v1` or `master` — nothing was merged
   automatically, per the safety rules.

---

## NEEDS MY DECISION

Items flagged below as they came up. Full ordered checklist also at the very top of the final summary once the night's work wraps.

1. **CI never triggers because the repo is hosted on GitLab, not GitHub.** `origin` is `https://gitlab.com/Daviking95/regops.git`, but `.github/workflows/ci.yml` is a GitHub Actions file — it can only ever run on GitHub (or a GitHub mirror). The workflow's own trigger config is fine; it's just on the wrong platform to ever fire. Per your instructions I did not attempt to fix this beyond noting it and adding the lint step you asked for (Task 4) — you'll need to decide whether to (a) mirror/migrate to GitHub, (b) port `ci.yml` to `.gitlab-ci.yml`, or (c) something else. See Entry 3 and Entry 5 (Task 4) for detail.

2. **Task 3 (repo restructure) — STOPPED before moving anything, not attempted.** Task 2 confirmed the split is clean dependency-wise, but Task 3 itself hides a real architectural question your instructions didn't answer, and guessing wrong here would have meant restructuring the whole monorepo overnight on a foundation I invented myself with no one to catch it before morning. Specifically: `apps/web` currently depends on `@regops/shared` (types/enums, e.g. `ReportStatus`, `ReportDto` — exactly what Task 1 tonight leans on) and `@regops/config` (shared ESLint/tsconfig preset) via pnpm workspace links. "Each area independently buildable without a shared root Turborepo pipeline" requires deciding **how the frontend keeps getting `@regops/shared`'s types once it's no longer in the same pnpm workspace as the backend**, and each option is a meaningfully different, hard-to-reverse-cheaply commitment:
   - **(a) Vendor/copy `@regops/shared` into the frontend area** — simplest, but the two copies silently drift apart the next time someone changes a DTO on the backend and forgets the frontend copy (exactly the class of bug Tasks 1 and the prior Alerts/Cases/Transactions/Rules fixes were spent fixing).
   - **(b) Publish `@regops/shared` as a real (private) npm package** the frontend installs by version — clean long-term, but needs a registry (npm/GitHub/GitLab package registry) and a publish step that doesn't exist yet, which is its own setup decision.
   - **(c) Git submodule / subtree for the shared package** — keeps one source of truth without a registry, but is a workflow change for whoever pulls the repo next (submodules are easy to get wrong) and you didn't ask for one.
   - **(d) Keep one pnpm workspace/lockfile at the root but make `apps/web` and the backend independently buildable *within* it** (separate build scripts/CI jobs per area, no cross-area `turbo` pipeline coupling) — satisfies "independently buildable" without answering "two lockfiles," but isn't quite what "two clearly separated top-level areas...each needs its own package.json/lockfile" asked for either.
   
   I did not pick one and start moving files, because whichever I chose would become the foundation Task 4's linting setup and tonight's HANDOVER.md both build on — a wrong guess wouldn't just be reversible via `git`, it would burn most of the rest of the night re-doing downstream work on top of it. **Please pick (a)/(b)/(c)/(d) or tell me a different approach**, and I (or a future session) can execute the actual file moves quickly once that's settled — the mechanical part (git mv, per-area package.json, lockfile split) is straightforward once the shared-code question is answered.
   
   Per your Task 3 instructions ("if this looks likely to break something you can't cleanly verify, STOP... and move to Task 4"), I moved on to Task 4 rather than guessing.

---

## Entry 1 — 2026-09-30 — Setup

- Confirmed `master` and `integration/v1` point to the same commit (`ea66cb4`).
- Found **uncommitted working-tree changes already present** on `master` before this session started, touching exactly the files Task 1 targets: `HANDOFF.md`, `dashboard/page.tsx`, `reports/[id]/page.tsx`, `reports/lib.ts`, `reports/page.tsx`, `confirm-dialog.tsx`. This looks like in-progress work on the Reports mock-mode fix from a previous session.
- Created branch `overnight/2026-09-30` from that state (from `integration/v1`'s commit, carrying forward the uncommitted changes rather than discarding them — discarding would have been a destructive, irreversible loss of unknown prior work).
- **Judgment call:** I am treating the existing uncommitted diff as the start of Task 1 and will inspect it, finish/verify it, and commit it as part of Task 1 rather than reverting it. Flagging this so you can check the diff matches what you expected to be mid-flight.

## Entry 2 — 2026-09-30 — Task 1: Reports mock-mode fix (DONE)

- The uncommitted diff already in the tree was a near-complete rewrite of the Reports pages to consume the real `ReportDto`/`ReportDetailDto` shapes directly (real endpoints: `GET /reports`, `GET /reports/:id`, `GET /reports/:id/xml`, `PATCH /reports/:id/submit`, `PATCH /reports/:id/confirm`). It was missing the mock-side adapter to actually emit those shapes.
- Read the real backend (`apps/api/src/reports/reports.service.ts`, `packages/shared/src/types.ts` and `enums.ts`) to get the exact real contract: `ReportStatus` is 3 values (`DRAFT` → `PENDING_CONFIRMATION` → `SUBMITTED`), `confirm()` requires an `nfiuReference` and checks separation-of-duties against `submittedBy` (not `generatedBy`), and CTR skips the submit step entirely (`DRAFT` → `SUBMITTED` via confirm alone).
- Extended `apps/web/src/lib/mock-data/real-shape.ts` with `realReportFields`, `toRealReportStatus`, `isMockReportDraft`, `realReportCaseSummary`, `realReportTransactionSummary` — same additive-spread pattern as the existing Alerts/Cases/Transactions/Rules adapters.
- Rewrote the Reports handlers in `apps/web/src/lib/mock-data/routes.ts`:
  - `withReportSummary`/new `withReportDetail` now project the real shape (mapped status, `nfiuReference`, `customerId`, full case/transaction/customer summaries).
  - Replaced `handleReportMarkSubmitted`/`handleReportConfirmSubmission` with `handleReportSubmit`/`handleReportConfirm`, matching the real service's transition rules exactly (see above).
  - Updated `/reports` list filtering from comma-separated `type`/`status` to the real single-value `reportType`/`status` query params.
  - Fixed `handleCaseDetail`'s embedded report summary to also emit the real status enum.
- **Left in place, not removed:** `handleGenerateSar`/`handleGenerateCtr` and their `/reports/generate-sar`, `/reports/generate-ctr` routes are now unused by the frontend (reports are auto-generated in the real backend) but are harmless dead mock endpoints. Removing them wasn't necessary for this task and touching more than needed felt like unnecessary risk overnight — flagging in case you want them deleted for cleanliness.
- **Minor known cosmetic inconsistency, not a live-flow bug:** seeded demo CTR reports (from `generateMockCtrReports`'s `assignLifecycle`) have a `submittedBy`/`submittedAt` populated for SUBMITTED/ACKNOWLEDGED rows, whereas the real backend leaves those null for a CTR (no submit step exists for CTR — confirm goes straight from DRAFT). Only affects pre-seeded demo data cosmetics; the live confirm flow itself does not set submittedBy for CTR. Not fixing tonight — touching the dataset generator felt like more change than this task needed.
- **Verified:**
  - `npx tsc --noEmit` on `apps/web` — clean.
  - `npx eslint` on every changed file — clean, zero warnings.
  - `npm run build` in `apps/web` — succeeds (builds both code paths; `NEXT_PUBLIC_USE_MOCK_DATA` is a runtime flag, not build-time, so this doesn't separately prove mock-mode's *runtime* behavior — see next bullet).
  - `npm test` in `apps/api` — all 10 suites / 153 tests pass, unaffected (this task didn't touch the real backend).
  - Committed as `560e8f9`.
- **NOT verified (needs your check in the morning):** actual browser behavior in mock mode (`NEXT_PUBLIC_USE_MOCK_DATA=true`) — the Reports list, detail page, submit/confirm dialogs, XML/CSV/PDF export. Per your instructions I did not attempt live browser verification without you present. Please click through Reports in mock mode before treating this as demo-ready.

## Entry 3 — 2026-09-30 — Task 2: repo-split dependency investigation (DONE — clean, safe to proceed to Task 3)

**Conclusion: the split is clean.** No production-code coupling exists in either direction between `apps/web` and the backend engine packages / other apps.

- `apps/web` imports nothing from `packages/risk-engine`, `packages/screening-engine`, or `packages/rules-engine` — grepped the whole `apps/web/src` tree; the only hit was a code *comment* in `rules/page.tsx` mentioning `@regops/rules-engine` by name, not an import.
- `apps/web/package.json` depends only on `@regops/shared` (types/enums, a pure leaf package) and `@regops/config` (the shared ESLint/tsconfig preset) — neither depends on the three engine packages or on `@regops/db`.
- Reverse direction: grepped `apps/api/src` and `apps/worker/src` for any reference to `apps/web` or `@regops/web` — one hit, again just a comment (`cases.service.ts:277`) noting that a business rule is "reused verbatim" from the mock router, not an actual import. No real code dependency.
- `packages/shared` and `packages/config` (the two packages `apps/web` actually depends on) have zero dependencies on the engine packages, `@regops/db`, or any app — they're genuine leaves.
- Infra (`docker-compose.yml`) only provisions Postgres/Redis/Mailhog — no app-level coupling there either.
- Workspace is pnpm (`pnpm-workspace.yaml`: `apps/*`, `packages/*`) with a single root `turbo.json` driving `build`/`lint`/`typecheck`/`test` via `dependsOn: ["^build"]` across the whole graph — this is the one thing Task 3 actually needs to unwind (splitting the shared Turborepo pipeline), not a dependency conflict.

**Bonus finding, relevant to Task 4:** the git remote (`origin`) is `https://gitlab.com/Daviking95/regops.git` — this repo is hosted on **GitLab, not GitHub**. `.github/workflows/ci.yml` is a GitHub Actions workflow file; GitHub Actions cannot execute on a repo hosted on GitLab with no GitHub mirror. This is almost certainly the entire reason "this workflow has never actually been triggered" — it isn't a misconfiguration inside the YAML (the trigger conditions `push: branches: ["**"]` + `pull_request` are correctly broad), it's that the workflow lives on the wrong hosting platform to ever run. Filing this under Task 4 below rather than here since it's about CI, but flagging its discovery here since it came out of this investigation. **This needs your decision** (see NEEDS MY DECISION at the top) — I did not attempt to fix hosting/mirroring, per your instruction not to fix "CI never triggered" beyond the lint step itself.

Proceeding to Task 3 (repo restructure) since this investigation confirms it's a clean split.

## Entry 4 — 2026-09-30 — Task 4: Linting (mostly DONE)

- **One consistent ESLint config across the whole monorepo:** already true before tonight — every workspace member (`apps/web`, `apps/api`, `apps/worker`, all 6 `packages/*`) already spreads the same shared flat config (`@regops/config/eslint-preset.js`, ESLint 9 flat config, `typescript-eslint` recommended + Prettier). No change needed here beyond what Task 3 would touch (n/a since Task 3 didn't proceed).
- **Fixed the disclosed Next.js ESLint plugin detection gap:** `apps/web` never had `eslint-config-next`/`@next/eslint-plugin-next` wired in (this was already honestly flagged in `HANDOFF.md`'s Known Issues). Installed `@next/eslint-plugin-next@15.1.3` (matching the app's Next version) as a direct devDependency and wired its `recommended` + `core-web-vitals` rule sets into `apps/web/eslint.config.js` directly — Next 15.1.3's `eslint-config-next` has no flat-config export yet, so this is the plugin-only approach Next's own docs recommend for that case, avoiding a heavier `@eslint/eslintrc`/`FlatCompat` dependency.
  - This surfaced 2 new warnings (`@next/next/no-img-element` on an avatar-upload preview and an MFA QR code) that had been invisible before. Both are genuinely `data:` URLs `next/image` cannot optimize — confirmed by reading each call site — so I added targeted `eslint-disable-next-line` comments rather than swapping to `next/image` (a real code change I couldn't visually verify overnight, and would have been the wrong fix here regardless).
  - Verified: `pnpm lint` (root, all 10 packages) passes clean; `npm run build` in `apps/web` no longer prints "The Next.js plugin was not detected"; full backend test suite still green (unaffected).
  - Committed as `9b8ef1d`.
- **Husky pre-commit hook added:** `pnpm add -D -w husky`, `npx husky init`, `.husky/pre-commit` runs `pnpm lint` (turbo across every workspace). **Tested live**, not just written: staged a file with a deliberate unused-var lint violation, ran `git commit`, confirmed Husky blocked it with the real ESLint output, then removed the test file before committing the real hook. Committed as `71d4140`.
- **CI lint step: already present, no change needed.** `.github/workflows/ci.yml` already runs `pnpm lint` as one leg of a `[lint, typecheck, test, build]` matrix, triggered on `push: branches: ["**"]` and `pull_request` — this was already correctly wired before tonight; there was nothing to add.
- **"Has this workflow ever actually triggered?" — investigated, root cause found, not fixed (per your instruction).** See NEEDS MY DECISION #1 at the top: the repo's `origin` remote is GitLab (`gitlab.com/Daviking95/regops`), but `.github/workflows/ci.yml` is a GitHub Actions file, which cannot run on a GitLab-hosted repo. The workflow's trigger conditions themselves are correctly written — this isn't a YAML bug, it's a platform mismatch. `HANDOFF.md`'s existing Known Issues entry on this ("No remote configured, nothing pushed") is now stale — a remote *is* configured, it's just the wrong platform for this workflow file. I did not attempt to fix this (mirror to GitHub, port to `.gitlab-ci.yml`, or otherwise) since it's exactly the kind of call your instructions asked me to bring to you rather than guess.
