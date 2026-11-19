# RECONSTRUCTION_ISSUES.md

DuskLabs CTF Platform — Stage 2 (reconstruction) issue ledger.
Source: `D:\openCboy\DuskLabs CTF Platform Development` (Google AI Studio chat export, 81 chunks, 337 code blocks).

## Status legend

- **UNRESOLVED-MISSING**: file/feature described in the source prose but never emitted as code; NOT fabricated.
- **DERIVED**: code assembled from prose specification (not verbatim from an emitted block); flagged per file.
- **ENVIRONMENT**: cannot verify in this environment (tooling absent).
- **COSMETIC**: formatting/deviation with no semantic effect.

---

## UNRESOLVED-MISSING

### 1. `apps/web/src/pages/CompetitionManagePage.tsx` (c35 @38880)

- Source describes the file and its features (admin competition lifecycle console) and cites its heading, but **no code fence follows** — the body was never emitted in the chat.
- During Script 1 this filename was mis-mapped to block 8 (`.env.example` content); the polluted copy was **deleted** in Script 2 per the missing-files policy.
- Consequence: route `/admin/competitions` (c35 prose) and Navbar drawer link "MANAGE COMPETITIONS" (c35) are **not wired** in `App.tsx` / `Navbar.tsx`; a "MANAGE COMPETITIONS" entry point exists in AdminDashboardPage prose only. Citing source: wiring a route to a non-existent component would break the build.

### 2. `apps/web/src/pages/AdminModerationPage.tsx` (c71 @46010)

- Same pattern: heading emitted, no following code fence. Polluted copy deleted.
- Consequence: route `/admin/moderation` and Navbar "MODERATION" drawer link (c71 prose) are **not wired**. Backend moderation routes/tests are fully present.

### 15. Organizer announcement controls in `apps/web/src/pages/CompetitionDetailPage.tsx` (c53 §6.3)

- Source prose (c53 §6.3) instructs: inside the `announcements` tab, when `user?.permissions.includes('announcement:publish')`, render an inline "Publish Announcement" form (`POST /api/v1/competitions/:id/announcements`) plus a `DELETE` button (`DELETE /api/v1/announcements/:id`). **No code fence is emitted anywhere in the export** (searched all 337 blocks).
- Consequence: the announcements tab is read-only for every role. Backend endpoints, RBAC, and organizer-ownership enforcement are complete and tested (`notifications.announcements.test.ts`); only the organizer UI is absent. Not fabricated.

## DERIVED (prose-to-code, not verbatim)

### 3. `apps/api/src/modules/competitions/registrations.service.ts` — c53 COMP_REG notification text

- Source specifies exact `type`, recipient targeting, and `dedupeKey` formats for the COMP_REG dispatches, but the **title/message/linkUrl strings** were not emitted verbatim; minimally derived to match the COMP_LIVE/COMP_END wording style.
- Team-flow requires member user IDs inside the transaction result; `memberUserIds` return added to tx result (source prose states the notification targets "all confirmed team member user IDs" but emits no code).

### 4. `apps/api/src/modules/competitions/competitions.service.ts` — c53 hook scoping

- In `executeLifecycleTransition`, the source prose references the competition inside the transaction; in the reconstructed flow the notifications dispatch happens after commit, so `competitionId` is taken from `params.competitionId` (equivalent value). Marked in stage2b manifest notes.

### 5. `apps/api/src/modules/submissions/submissions.service.ts` — totalAwarded response fields

- c29 prose specifies the solve response must expose `totalAwarded` (points + first-blood bonus) and `firstBloodBonusAwarded`; no verbatim block covers the response DTO, so the two fields were appended to the [134] response in the documented shape.

### 6. `apps/web/src/pages/ChallengeDetailPage.tsx` — hints fetch/handler wiring

- c26 emits the interfaces ([153]) and the hints JSX section ([154]) verbatim, but the `loadChallenge` integration lines (fetch `GET .../hints`, set state) and `handleUnlockHint` placement come from prose. Handler body is verbatim from c26 prose.

### 7. `apps/web/src/App.tsx` — route table hand-assembly

- Base [73] + per-chunk route additions were emitted as scattered prose; assembled into one JSX route table. All 26 imported pages exist on disk. Routes `/admin/competitions` and `/admin/moderation` intentionally omitted (see items 1–2).

### 8. `apps/web/src/components/layout/Navbar.tsx` — drawer link wiring

- [62] base + c17/c20/c29/c56/c65/c68/c74 conditional links assembled from prose. Two omissions:
  - c53 **unread-notification counter badge**: prose describes it but no emitted code specifies the counting API/shape; simple "NOTIFICATIONS" link wired instead.
  - "MANAGE COMPETITIONS" and "MODERATION" links omitted (target pages missing; items 1–2).
- `user.permissions` shape verified against disk `AuthContext.tsx`.

### 9. `apps/api/src/app.ts` — hand-assembled wiring (largest derived file)

- Base [37]; per-chunk route registration snippets (blocks listed in stage2b manifest); c53 notification services; c56 achievements; c74 settings injection; c35 `CompetitionLifecycleScheduler` (instantiate, expose as `lifecycleScheduler`, start unless `NODE_ENV==='test'` / `enableScheduler:false`, stop in `onClose`).
- `BuildAppOptions` shape pinned from 19 test call sites: `env`, `prisma`, `authRateLimitMax`, `submitRateLimitMax`, `contactRateLimitMax` (+ `globalRateLimitMax`, `enableScheduler`).
- Service constructor extension points verified against per-block constructor signatures.

## ENVIRONMENT

### 10. Rust crate — not compiled

- `services/rust/Cargo.toml`, `services/rust/crates/attachment-processor/Cargo.toml`, `src/main.rs`, `src/inspector.rs` are reconstructed from emitted code blocks but `cargo` is not installed on this machine, so `cargo check/build` was not run. Status: **reconstructed, not compiled**.

### 11. Stage 3/4 not executed (per instructions)

- No `npm install`, `prisma generate`, migrations, builds, or tests were run. All verification was static: import resolution (49 app.ts imports → all resolve), route-deps matching (21 route functions), service-method existence (all routes-called methods present), schema field spot-checks, web page existence (26 pages).

## COSMETIC

### 12. Announcements route header formatting

- c233 insert normalized to standard multi-line `app.get(` layout (source emitted it with `{ preHandler: ... }` inline); syntax-equivalent.

### 13. `env.ts` merge artifact fixed

- Script 1 left a double comma (`,,`) from blocks [27]+[122]+[123] insertion; fixed in Script 2.

### 14. Column-0 `) {` / `function` lines faithful to source

- `competitions.routes.ts`, `competitions.service.ts`, `registrations.service.ts` contain `) {` at column 0 and a col-0 helper `function isUniqueOrRaceError` — verified present in the original blocks [197]/[196]/[221]; left as-is (faithful).

---

## STAGE 4 — changes applied during build/repair (2026-11-18)

All item numbers refer to the ledger above. Stage 4 fixes are listed in `dusklabs-recon/analysis/STAGE4_REPORT.md` with root cause + verification. Summary of source changes:

1. **HIGH — `packages/shared/src/enums.ts`**: added `'achievement:manage'` to `PermissionKeys`; granted to `PLATFORM_ADMIN` and `COMPETITION_ORGANIZER` (SUPER_ADMIN inherits via `[...PermissionKeys]`), per c56 §3.1. Seed re-run picks it up.
2. **`packages/shared/src/schemas.ts`** rebuilt from source blocks (Stage 2 concatenation had merged block boundaries mid-line and omitted `import { z }`); later blocks win; disk-only c56/c68/c74 schemas retained. Also restored c35 block 195 (`updateCompetitionSchema`, `assignOrganizerSchema`, timezone/dynamic policy validation — `target=None` in the Stage 2 index caused it to be skipped) and c35 block 194 (`DynamicScoringPolicies` enum).
3. **`apps/api/src/plugins/security.ts`**: removed duplicated `import multipart` + stray comment inside the function body (block-boundary artifact); CORS rejection now carries `statusCode: 403` (bare `Error` produced 500; Phase 6 SEC-03 expects 403).
4. **`apps/api/src/utils/errors.ts`**: handler parameter `error: unknown` (Fastify v5 `setErrorHandler` signature) with the same narrowing logic.
5. **`apps/api/src/modules/moderation/moderation.service.ts`**: `timestamps: [] as number[]`, `new Map<string, number>()` so the `??` fallback literal does not degrade to `never[]`.
6. **`apps/api/src/app.ts`**: `buildApp` returns the already-instantiated `scoringService` (required by `scoring.test.ts`; no behaviour change).
7. **`apps/api/src/modules/attachments/attachments.routes.ts`**: SEC-09 — oversize uploads now deterministically return 413. Busboy truncates at the multipart `fileSize` limit and, for buffered bodies, emits `limit` before any consumer listener attaches, so the part's `truncated` flag is checked when `request.file()` resolves; a `limit` listener covers the streaming case.
8. **`packages/shared/src/schemas.ts`** (VULN-01, c77): `httpUrlSchema` applied to `createTeamSchema.logoUrl`, `updateTeamSchema.logoUrl`, and competition `bannerUrl`; definition moved above first use (TDZ).
9. **`apps/api/src/modules/scoring/scoring.service.ts`**: INDIVIDUAL standings key on `userId` for every transaction/solve (global INDIVIDUAL previously dropped team-attributed rows, so team players never appeared and `currentUserEntry` was always null).
10. **Tests (contract repairs for source-internal inconsistencies; no assertions removed)**:
    - `achievements.test.ts`: authorized `POST /api/v1/admin/achievements` returns 201 + cleanup ordering (achievement definitions are Restrict-guarded by `UserAchievement`).
    - `notifications.announcements.test.ts`: unread count 4 → 5 and 3 → 4, plus `ACHIEVEMENT` in the type list — the Phase 4.6 Competition Participant award now emits a fifth notification; dedup assertion unchanged.
    - `admin.moderation.test.ts` / `admin.overview.test.ts`: afterAll clears Restrict-FK children (dispute corrections, reports, untracked competition) before deleting users.
    - `apps/api/vitest.config.ts`: `testTimeout: 60_000`, `hookTimeout: 30_000` (Argon2id 64 MiB per auth call on SQLite exceeds the 5 s unit default).
11. **`apps/web/src/components/ui/SafeMarkdown.tsx`**: `isSafeHttpUrl` exported (its security test imports it).
12. **`apps/web/src/pages/AchievementsPage.tsx`**: award-history badge reads `h.tier` (service exposes `tier`; `awardedTier` never existed).

Still unresolved after Stage 4: items 1, 2, 15 (missing UI), item 10 (Rust not compiled — no toolchain), item 8 badge omission.

---

## Resolution notes

- Items 1–2 (missing pages): if the original chat files ever become available, restore them and add the two routes + two Navbar drawer links guarded as in the prose.
- Item 10: compile the Rust crate with `cargo check` once toolchain is available.
