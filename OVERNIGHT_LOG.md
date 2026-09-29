# Overnight Log — 2026-09-30

This file is a running log of autonomous work done overnight on branch `overnight/2026-09-30`.
Entries are appended after each completed task. Read this first before looking at anything else.

---

## NEEDS MY DECISION

Items flagged below as they came up. Full ordered checklist also at the very top of the final summary once the night's work wraps.

1. **CI never triggers because the repo is hosted on GitLab, not GitHub.** `origin` is `https://gitlab.com/Daviking95/regops.git`, but `.github/workflows/ci.yml` is a GitHub Actions file — it can only ever run on GitHub (or a GitHub mirror). The workflow's own trigger config is fine; it's just on the wrong platform to ever fire. Per your instructions I did not attempt to fix this beyond noting it and adding the lint step you asked for (Task 4) — you'll need to decide whether to (a) mirror/migrate to GitHub, (b) port `ci.yml` to `.gitlab-ci.yml`, or (c) something else. See Entry 3 and Entry 5 (Task 4) for detail.

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
