# DuskLabs Missing Functionality & Impact Audit

**Audit mode:** Read-only source inspection. No dependencies were installed; no build, tests, database commands, migrations, or runtime services were executed. No source files were changed. This report is the only requested repository addition.

**Repository state inspected:** `JunaidAce/dusklabs`, `main`, commit `db3b423e47f1ce758373832f0a1431730d5473d7` (2026-11-19).

## Executive summary

No reported missing page is imported into the frontend route table, so neither absent page causes a missing-module TypeScript/build error in the checked-in route setup. The core React app and API are structured to start independently of the Rust service, and attachment uploads have a TypeScript fallback enabled by default. However, the repository does not establish that the site currently runs: dependencies, generated Prisma Client, database availability/schema, and builds/tests were not verified.

Two reported UI gaps are **not present in this inspected revision**: the organizer announcement publishing form is in `CompetitionDetailPage.tsx`, and the unread-count badge is in `Navbar.tsx`. The two admin pages are absent, leaving competition-management and moderation workflows without their intended dedicated web screens, although their backend APIs/services are present. The Rust crate has source and a manifest but is uncompiled/unverified. Seven files are explicitly marked as reconstructed from prose rather than verbatim source; this is a provenance/verification risk, not evidence by itself of a compile or behavior failure.

## Classification

- **CRITICAL:** Website cannot start or core functionality is broken.
- **HIGH:** Important functionality is broken.
- **MEDIUM:** Partial functionality or missing UI.
- **LOW:** Cosmetic or non-essential issue.

No CRITICAL finding was established from static inspection. A deployment-readiness concern around absent checked-in migrations is separately noted below as HIGH.

## Findings by reported issue

### 1. `apps/web/src/pages/CompetitionManagePage.tsx` is missing — **MEDIUM**

**Evidence:** The file is absent from the source tree. `apps/web/src/App.tsx` has no import or route for `/admin/competitions`. `AdminDashboardPage.tsx` nevertheless renders a “MANAGE COMPETITIONS” link to `/admin/competitions`, so clicking that dashboard link reaches no matching route and renders no competition-management screen.

- **Website start / frontend build:** Not a startup blocker and does not create a missing-import TypeScript error in the current route table. No build was run, so unrelated build errors are not ruled out.
- **Existing routes:** Other declared routes are not displaced. The linked `/admin/competitions` path is unmatched; it is not a working route.
- **Backend / database:** No direct backend or schema break. Competition routes and service logic are registered, including list/create/update/publish/archive/delete, lifecycle transitions, organizer assignment, and registration management. These endpoints use the existing Prisma competition and registration models.
- **Affected users/features:** Platform admins and competition organizers cannot use the intended dedicated browser console for competition setup, lifecycle, organizer, or registration administration. Participants’ public competition listing/detail/registration/leaderboard paths are separate and remain wired.
- **Missing entirely vs UI-only:** The named page and route are missing; competition business logic and APIs are not missing. Browser workflows for the unavailable management screen are absent, not the underlying API functionality.
- **Alternative implementations:** `AdminDashboardPage` links to the missing route but is not a substitute. API/service operations exist for a trusted client or direct API caller; no alternative web management page was found.

### 2. `apps/web/src/pages/AdminModerationPage.tsx` is missing — **MEDIUM**

**Evidence:** The file and `/admin/moderation` route are absent from `App.tsx`; the navbar has no moderation link. The API registers moderation routes in `apps/api/src/modules/moderation/moderation.routes.ts`, and `ModerationService` contains submission inspection/dispute resolution, suspicious-activity summaries, report queues and report moderation. API tests include `admin.moderation.test.ts`.

- **Website start / frontend build:** Not a startup or missing-import build blocker because no import/route references the absent page. Build/test execution was not performed.
- **Existing routes:** Existing routes remain declared; `/admin/moderation` is simply not a frontend route.
- **Backend / database:** Moderation APIs and data operations are present. Prisma schema includes `Report`, `SubmissionDisputeCorrection`, and `AccountModerationRecord`; these operations are not removed by the missing page.
- **Affected users/features:** Moderators, platform admins, and organizers lose the intended moderation console. Report submission and other public/participant functionality is separate. Some account-management controls may exist in user administration, but they do not replace the report/submission moderation queues.
- **Missing entirely vs UI-only:** The dedicated moderation UI is missing. Backend moderation functionality is present; therefore this is principally a UI/accessibility gap rather than missing API/database implementation.
- **Alternative implementations:** Moderation service/routes and tests are present, but no alternative moderation page was found. A client able to call the protected endpoints could still use the backend.

### 3. Organizer announcement publishing UI — **LOW (reported issue not present in this revision)**

**Evidence:** `CompetitionDetailPage.tsx` includes the `announcement:publish` permission check, form state and submit handler, and renders a “PUBLISH ANNOUNCEMENT” form in the announcements tab. It POSTs to `/api/v1/competitions/:id/announcements`. The API route is registered and the service verifies platform-admin or competition creator/organizer ownership before writing the announcement and notifying participants. `notifications.announcements.test.ts` exercises authorization and persistence.

- **Website start / frontend build:** No startup/build impact identified from this item; not executed.
- **Existing routes:** Competition announcement tabs are wired at `/competitions/:slug/announcements` and the publish action uses an existing API route.
- **Backend / database:** Announcement API, RBAC/ownership checks, database writes, and participant notifications are present.
- **Affected users/features:** Users with `announcement:publish` can see and submit the organizer form; server-side ownership checks restrict each competition to an authorized organizer/admin. Participants can read announcements.
- **Missing entirely vs UI-only:** Publishing UI is present, so the specific reported gap is stale or inaccurate for the audited commit. A narrower management gap remains: no edit/delete controls were found in this page, although PATCH/DELETE announcement endpoints exist.
- **Alternative implementations:** The inline form in `CompetitionDetailPage.tsx` is the implementation. Global announcement creation has its own protected admin API, but no corresponding global-announcement publishing UI was established in this audit.

### 4. Notification unread-count badge — **LOW (reported issue not present in this revision)**

**Evidence:** `Navbar.tsx` requests `/api/v1/notifications?limit=1`, reads `unreadCount`, displays a badge next to “ALERTS,” and shows the count in the navigation drawer. It loads when the component mounts and refreshes on window focus. The notification API/service calculates unread count, and `NotificationsPage.tsx` also displays the total and supports mark-read/mark-all-read.

- **Website start / frontend build:** No startup/build impact identified; not executed.
- **Existing routes:** `/notifications` is routed and protected; API endpoints for listing and marking read are registered.
- **Backend / database:** Notification records, unread counts, and read operations are implemented using the Prisma `Notification` model.
- **Affected users/features:** Signed-in users see the badge. The number can be stale while the page remains focused because the navbar has no polling or push-refresh mechanism; focus refresh and inbox refresh are present.
- **Missing entirely vs UI-only:** Neither the badge nor its supporting API/count is missing.
- **Alternative implementations:** Both the navbar badge and inbox unread count exist.

### 5. Rust attachment processor is uncompiled — **MEDIUM (verification/deployment risk)**

**Evidence:** `services/rust` contains a Cargo workspace, `attachment-processor` manifest, HTTP service (`src/main.rs`), archive/MIME inspector (`src/inspector.rs`), and a Rust README describing the internal endpoint. The reconstruction issue ledger says it was not compiled because the toolchain was unavailable. No compile/test was run during this audit.

- **Website start / frontend build:** Rust is a separate internal service and is not imported by the web app. Its uncompiled state does not by itself prevent frontend or TypeScript API startup.
- **Existing routes:** No public website route is directly affected. Upload APIs call the Rust service internally when available.
- **Backend / database:** Attachments API and file-vault/metadata persistence are present. With Rust unavailable and `ALLOW_TS_ATTACHMENT_FALLBACK=true` (the `.env.example` default), `AttachmentsService` uses `attachmentFallback.ts` for inspection. With fallback disabled, Rust unavailability causes uploads to fail with 503; other API/database operations are not contingent on Rust. Attachment records store the inspection engine.
- **Affected users/features:** Challenge authors/organizers uploading or replacing challenge artifacts are affected if the service is not built/running and fallback is disabled; download and unrelated CTF flows are not inherently blocked.
- **Missing entirely vs UI-only:** Rust source is present but its compiled executable and successful compilation are unverified. Attachment inspection functionality has a TypeScript alternative.
- **Alternative implementations:** TypeScript fallback implements file-type checks, size checks, ZIP metadata/path safety checks, and SHA-256 reporting. Production should not assume the Rust service is deployable until a Rust toolchain build and the Rust-to-API integration are verified.

### 6. Seven files reconstructed from prose rather than original emitted source — **MEDIUM (provenance and test-coverage risk)**

The repository’s `RECONSTRUCTION_ISSUES.md` explicitly marks these seven files/areas as derived or hand-assembled:

1. `apps/api/src/modules/competitions/registrations.service.ts` — registration notification text and team-member notification targeting.
2. `apps/api/src/modules/competitions/competitions.service.ts` — lifecycle-notification hook scoping after transaction commit.
3. `apps/api/src/modules/submissions/submissions.service.ts` — solve response award-total fields.
4. `apps/web/src/pages/ChallengeDetailPage.tsx` — hints fetch/handler integration.
5. `apps/web/src/App.tsx` — route-table assembly.
6. `apps/web/src/components/layout/Navbar.tsx` — navigation-link assembly.
7. `apps/api/src/app.ts` — API/service/route wiring assembly.

- **Website start / frontend build:** Derived provenance does not prove a start/build error. The reconstruction log reports static import and route-wiring checks, but explicitly says builds, typechecks and tests were not run. No such validation was run as part of this audit.
- **Existing routes:** The currently declared route table has no imports of the two missing pages. The absent competition-management path is separately identified above. Other route behavior cannot be proven from provenance alone.
- **Backend / database:** These files participate in API wiring, competition notifications, flag-solve responses, and hint UI flows, so a behavioral/API contract deviation could affect these features. No specific runtime/database defect is demonstrated by the issue ledger. The schema and Prisma models are present.
- **Affected users/features:** Competition registrants receiving notifications; organizers managing competition lifecycle; challenge solvers viewing hint flows and solve totals; all users depending on route/navbar wiring; API users of the assembled service composition.
- **Missing entirely vs UI-only:** The files exist; the issue is reconstruction provenance and lack of full executable verification, not absent functionality by itself.
- **Alternative implementations:** No known verbatim originals are present in this repository. Existing tests and static checks offer partial evidence, not proof of equivalence to the missing source export.

**Audit recommendation:** Treat the seven derived areas as requiring targeted typecheck/build and relevant API/UI regression tests before deployment, rather than assuming either that they are broken or that static checks prove correctness.

## Architecture and feature-path review

### Frontend and backend

- **Frontend:** React 18, TypeScript, Vite, and React Router 6 in `apps/web`. `main.tsx` mounts the app; `App.tsx` provides `BrowserRouter`, `AuthProvider`, `PageLayout`, routes, and `ProtectedRoute` for sign-in-only areas. A protected route checks for a user session, not a particular admin permission; the page components and API authorization are responsible for permission-specific access.
- **Backend:** Fastify 5 TypeScript API in `apps/api`, started by `src/server.ts` via `buildApp()` in `src/app.ts`. `app.ts` instantiates services, registers API modules and security plugins, and starts the competition scheduler outside tests by default.
- **Shared contracts:** `packages/shared` supplies role/permission enumerations, schemas, and types. API inputs are generally parsed with Zod.
- **Startup commands in manifests:** Root scripts provide `dev:api`, `dev:web`, API build/typecheck/test, and web build/typecheck. There is no root production start script or deployment orchestration file in the inspected tree.

### Authentication and authorization

- Auth uses an HTTP-only `dusklabs_sid` cookie; session tokens are hashed in storage. The web auth context calls `/api/v1/auth/me` and retains the returned CSRF token for writes.
- API middleware loads active, non-expired sessions, roles, and permissions; state-changing protected routes require CSRF validation and route-specific permission checks.
- The frontend `ProtectedRoute` only checks signed-in status. API authorization remains the enforcement boundary, so hiding/omitting admin pages is not itself an authorization control.
- Roles include `SUPER_ADMIN`, `PLATFORM_ADMIN`, `COMPETITION_ORGANIZER`, `CHALLENGE_AUTHOR`, `MODERATOR`, `TEAM_CAPTAIN`, and `PARTICIPANT`; shared permission mappings and seeded role assignments are present.

### API routes, persistence, and migrations

- `apps/api/src/app.ts` wires auth, dashboard, teams, challenges, attachments, scoring, notifications, announcements, achievements, competitions/registrations, submissions, hints, leaderboards, contact, admin, moderation, audit, analytics, and settings modules.
- `apps/api/prisma/schema.prisma` contains the PostgreSQL data model for users/sessions/RBAC, teams, competitions/registration, challenges/flags/hints, submissions/solves/score transactions, achievements, announcements/notifications, reports/moderation, audit logs, and platform settings. A SQLite schema and script are provided for evaluation.
- **Deployment concern — HIGH:** The inspected tree has Prisma schema files and scripts but no checked-in `apps/api/prisma/migrations/` history. `db:migrate:pg` invokes `prisma migrate dev`, but reproducible production migration history is not present in this tree. A fresh deployment must not be assumed to have a provisioned schema. Establish and verify a production database migration/provisioning process before deployment; this audit did not run it.
- `.env.example` lists required DB URL, session and flag secrets, upload path, and Rust settings. Its example security values are explicitly placeholders and must be replaced with strong production secrets. Database connectivity, generated Prisma Client, and deployed schema status are not known.

### Challenge and flag workflow

- Challenge routes/services implement public listings/details and permission-protected author/admin CRUD, lifecycle changes, flag configuration/testing, hints, and attachments.
- `SubmissionsService` checks publication state and competition availability/registration, prevents repeat solves, enforces configured attempts, verifies static or participant-derived dynamic flags, records submissions, and delegates atomic solve/scoring to `ScoringService`.
- Flag data is stored as HMAC digests for static flags or authenticated encryption for dynamic seeds; scoring records solve, first-blood, and dynamic recalculation transactions. The repository includes API tests for flags, challenges, submissions/scoring, and hints, but tests were not run here.

### Competition management and leaderboards

- Competition service and API routes cover creation/edit/publish, organizer assignment, registration, allowed lifecycle transitions, and scheduled transitions. The scheduler checks schedule windows every 30 seconds. Access is scoped by platform-admin role or competition ownership/organizer assignment in service logic.
- Public competitions and detail tabs, participant/team registrations, challenge listings, announcements, and competition leaderboard are wired. The missing dedicated admin page removes the normal web console, not these APIs/public features.
- `ScoringService.computeStandings` builds individual/team standings from score transactions and solve records; leaderboard API/service provides global and competition rankings and recent solves. The relevant pages/routes are present in the inspected tree.

### Uploads and Rust integration

- Challenge attachment routes enforce signed-in/CSRF/permission checks, multipart file-size guards, and service-side challenge ownership checks. Files are stored under a vault path with metadata in `ChallengeAttachment`; downloads check challenge visibility and competition registration/status.
- The Rust internal endpoint validates a service token and vault-relative storage key and inspects SHA-256, MIME/extension, and ZIP metadata without extracting archives. The API uses a TypeScript fallback only when Rust is unavailable and fallback is allowed.
- The Rust workspace is not shown as part of npm build/start scripts. It needs a separately provisioned executable/service if the deployment expects Rust rather than fallback inspection.

### Notifications

- Notification dispatch persists per-user notifications and supports dedupe keys, unread counts, pagination, read-one/read-all, and optional email-adapter calls. Competition lifecycle and announcements dispatch notifications to participants.
- The API and database work is present; navbar badge and notifications inbox UI are also present. The badge refreshes at mount and on window focus rather than continuously.

## Overall answers

1. **Can DuskLabs currently run?** The source layout provides separate frontend/API development entry points and no identified reported issue blocks those entry points. Whether it actually runs is **unverified**: no dependencies, build, typecheck, API tests, database, or runtime service were exercised. It requires compatible installed dependencies, generated Prisma Client, valid environment secrets, a reachable database with the schema provisioned, and separate Rust service provisioning if Rust inspection is required.
2. **Which features actually work?** Static source inspection shows implemented/wired public pages and API paths for authentication, teams, challenges, submissions/flag verification, hints, scoring, competition browsing/registration/lifecycle APIs, leaderboards, announcements publishing/reading, notifications and attachments. This is source-level presence, not a claim of runtime-tested operation.
3. **Which features are broken or incomplete?** The dedicated `/admin/competitions` console and `/admin/moderation` console are absent; the dashboard competition link has no destination route. Those pages’ backend operations are present. Organizer announcement publishing and navbar unread badge are present in the inspected revision. Announcement edit/delete controls in the competition page are not evident. Rust compilation/integration and seven derived-file behavioral equivalence remain unverified.
4. **What must be fixed/verified before deployment?** Provide and verify a reproducible PostgreSQL schema migration/provisioning process (no migration history is checked in); replace placeholder secrets and validate production environment configuration; run the API/web production builds and typechecks plus relevant regression tests; confirm Prisma generation and a fresh database setup; compile and integration-test the Rust service if it is required, or deliberately configure/test the TypeScript fallback. Restore/implement admin consoles before launch if competition or moderation administration must be available through the web UI.
5. **What can safely be postponed?** A live/push unread badge refresh can be deferred (it refreshes on focus); Rust can be deferred as a deployment dependency only if the TypeScript fallback is explicitly enabled and tested against the required security policy; admin consoles can be postponed only if those management workflows are not needed at launch and trusted API operation is an accepted interim process. Announcement edit/delete UI and provenance comparison can also be scheduled according to product needs, but derived code still needs regression verification before production.

## Evidence index

- `RECONSTRUCTION_ISSUES.md` and `RECONSTRUCTION_LOG.md` — missing-page/provenance ledger, prior static checks, and explicit statement that builds/tests were not run.
- `apps/web/src/App.tsx`, `AdminDashboardPage.tsx`, `CompetitionDetailPage.tsx`, `Navbar.tsx`, `NotificationsPage.tsx` — routes, admin link, announcement form, badge, and inbox.
- `apps/api/src/app.ts`, `middleware/auth.ts`, `modules/competitions/*`, `modules/announcements/*`, `modules/moderation/*`, `modules/notifications/*`, `modules/submissions/*`, `modules/scoring/*`, `modules/leaderboards/*`, and `modules/attachments/*` — backend wiring and workflows.
- `apps/api/prisma/schema.prisma`, `schema.sqlite.prisma`, `package.json`, `apps/api/package.json`, `apps/web/package.json`, `.env.example`, and `services/rust/**` — persistence/build/env/Rust implementation.
