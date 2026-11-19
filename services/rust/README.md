# DuskLabs Rust Services Workspace

Selective high-performance services complementing the Node.js/TypeScript backend.
Auth, RBAC, Prisma persistence, flag validation, and scoring remain in TypeScript.

## Implemented (Phase 2 — Step 2.4)
- `crates/attachment-processor`:
  - Streaming SHA-256 hashing
  - Binary magic-byte MIME detection (`infer`)
  - Safe ZIP inspection without extracting to disk
  - Path traversal (`..`, absolute paths, backslash separators) & ZIP bomb protection
  - Configurable size, entry-count, and compression-ratio limits
  - Internal loopback HTTP endpoint (`127.0.0.1:4100/internal/v1/attachments/inspect`)

## Planned for Later Phases (When Measurably Needed)
- `crates/analytics-engine`: Large competition statistics & RFC-4180 CSV export streaming.
- `crates/event-worker`: Asynchronous submission-event aggregation & leaderboard snapshots.

## Build & Test (Requires Stable Rust + Cargo)
