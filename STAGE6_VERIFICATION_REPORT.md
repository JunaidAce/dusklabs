# DuskLabs Stage 6 — Build & Runtime Verification Report

**Verification date:** 2026-11-19  
**Repository:** `JunaidAce/dusklabs` (`main`)  
**Local path:** `D:\openCboy\dusklabs`  
**Scope:** Pulled latest from GitHub, ran requested builds/typechecks/tests/Prisma generation checks, and recorded actual results. No source/config files were modified except this report; no `.env` was modified; no migrations/seed/reset commands were run; no credentials were used/disclosed.

## 1) Repository sync (pulled fresh)

- **Command:** `git fetch origin` / `git pull --ff-only origin main`
- **Result:** PASS (fast-forward)
- **Before pull:** `HEAD db3b423` (`main`, up to date with prior `origin/main`)
- **Incoming commits pulled:** `169b044 docs: add read-only missing functionality audit`, `64cdc17 docs: add Stage 6 verification report`
- **After pull:** `HEAD 64cdc17` (`main...origin/main`, up to date)
- **Files added by pull:** `MISSING_FUNCTIONALITY_AUDIT.md`, `STAGE6_VERIFICATION_REPORT.md`
- **Working tree at verification start:** clean (no local uncommitted changes)

## 2) Environment notes (observed)

- **Node:** `v24.21.0`
- **npm/npx:** `npm.ps1`/`npx.ps1` blocked by PowerShell execution policy in this shell; commands executed via `npm.cmd`/`npx.cmd` (successful).
- **Dependencies:** `node_modules` present at repo root, `apps/api`, and `apps/web` (`packages/shared/node_modules` not present as a separate folder; workspace linked).
- **Running processes observed during verification:** `apps/api` dev server (`tsx watch src/server.ts`, PID 18012 listening on port 4000) and `apps/web` dev server (`vite`, PID 7452 listening on port 5173), plus related npm/node wrapper processes. These held locks on Prisma engine files in `node_modules/.prisma/client/` and affected Prisma generation (see §5).

## 3) Builds and typechecks

| Check | Command | Result | Exit code | Actual output / notes |
|---|---|---:|---:|---|
| Shared package build | `npm.cmd --workspace=packages/shared run build` | PASS | 0 | `tsc -p tsconfig.json` completed successfully. |
| Backend (API) typecheck | `npm.cmd --workspace=apps/api run typecheck` | PASS | 0 | `tsc -p tsconfig.typecheck.json` completed successfully. |
| Backend (API) build | `npm.cmd --workspace=apps/api run build` | PASS | 0 | `tsc -p tsconfig.json` completed successfully. |
| Frontend (web) typecheck | `npm.cmd --workspace=apps/web run typecheck` | PASS | 0 | `tsc --noEmit` completed successfully. |
| Frontend (web) build | `npm.cmd --workspace=apps/web run build` | PASS | 0 | `tsc -b && vite build` succeeded. Vite v5.4.21, 94 modules transformed. Output: `dist/index.html` (0.79 kB), `dist/assets/index-CCxjU0y6.css` (21.64 kB), `dist/assets/index-DZ-cL86t.js` (383.55 kB). Built in 1.09s. |

## 4) API tests

| Check | Command | Result | Exit code | Actual output / notes |
|---|---|---:|---:|---|
| Existing API automated tests | `npm.cmd --workspace=apps/api run test` (`vitest run`) | FAIL | 1 | **Test Files:** 23 failed (23). **Tests:** 40 skipped (40). **Duration:** 14.27s (transform 527ms, setup 0ms, collect 8.35s, tests 244ms, environment 3ms, prepare 2.39s). |

**Observed failure cause (from output):** failures occurred during test setup/hooks with Prisma datasource validation/initialization errors, e.g. `PrismaClientInitializationError: error: Error validating datasource \`db\`: the URL must start with the protocol \`postgresql://\` or \`postgres://\`.` referencing `schema.prisma:11` (`provider = "postgresql"`, `url = env("DATABASE_URL")`). Affected suites included (not exhaustive): `tests/admin.competitions.test.ts`, `tests/admin.moderation.test.ts`, `tests/admin.overview.test.ts`, `tests/admin.settings.test.ts`, `tests/admin.users.test.ts`, `tests/attachments.test.ts`, `tests/auth.security.test.ts`, `tests/challenges.test.ts`, `tests/competitions.crud.test.ts`, `tests/competitions.lifecycle.test.ts`, `tests/competitions.pages.test.ts`, `tests/competitions.registration.test.ts`, `tests/contact.test.ts`, `tests/flagValidation.test.ts`, `tests/hints.test.ts`, `tests/leaderboards.test.ts`, `tests/notifications.announcements.test.ts`, `tests/schema.compatibility.test.ts`, `tests/scoring.test.ts`, `tests/security.matrix.test.ts`, `tests/teams.test.ts` (and related hook errors such as `TypeError: Cannot read properties of undefined (reading 'app'/'close')` as cascading cleanup failures). No test DB/schema changes were made during this run.

## 5) Prisma Client generation

| Check | Command | Result | Exit code | Actual output / notes |
|---|---|---:|---:|---|
| SQLite schema sync + generate | `npm.cmd run db:generate:sqlite` | FAIL | 1 | `db:sync:sqlite` succeeded: `Synced SQLite schema -> D:\openCboy\dusklabs\apps\api\prisma\schema.sqlite.prisma`. `prisma generate --schema=apps/api/prisma/schema.sqlite.prisma` then failed: `EPERM: operation not permitted, rename 'D:\openCboy\dusklabs\node_modules\.prisma\client\query_engine-windows.dll.node.tmp17436' -> 'D:\openCboy\dusklabs\node_modules\.prisma\client\query_engine-windows.dll.node'`. |
| PostgreSQL schema generate | `npm.cmd run db:generate:pg` | FAIL | 1 | `prisma generate --schema=apps/api/prisma/schema.prisma` failed: `EPERM: operation not permitted, rename 'D:\openCboy\dusklabs\node_modules\.prisma\client\query_engine-windows.dll.node.tmp696' -> 'D:\openCboy\dusklabs\node_modules\.prisma\client\query_engine-windows.dll.node'`. |

**Likely cause (observed):** the Prisma query engine DLL in `node_modules/.prisma/client/` was locked by running dev processes at the time of generation (API server listening on port 4000, PID 18012; Vite dev server listening on port 5173, PID 7452, and related node processes). Generation was not retried with services stopped.

## 6) Summary

- **Pulled fresh from GitHub:** yes (`db3b423..64cdc17`, fast-forward).
- **Shared package build:** PASS.
- **Backend typecheck:** PASS. **Backend build:** PASS.
- **Frontend typecheck:** PASS. **Frontend build:** PASS.
- **API tests:** FAIL — 23/23 test files failed, 40 tests skipped (14.27s); failures dominated by Prisma datasource/provider-URL validation errors against `schema.prisma` (PostgreSQL provider) in the current environment.
- **Prisma Client generation:** FAIL for both `db:generate:sqlite` (sync step succeeded, generate step hit EPERM on locked query engine DLL) and `db:generate:pg` (EPERM on locked query engine DLL) while dev servers were running.

**Overall:** builds and typechecks passed; API test execution and Prisma client generation did not pass under the observed environment/runtime conditions above.
