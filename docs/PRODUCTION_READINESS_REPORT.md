# Sajilo production-readiness report

Date: 2026-09-29
Production Worker: `ec1565d8-61d8-4149-82ad-9ebaf85f7f7a`

## 1. Important files changed

- Runtime: `cloudflare-worker.ts`, `server.ts`, `domain.ts`, `app.js`, `style.css`, `auth.css`, `sw.js`
- D1: `migrations/0005_allow_cancelled_orders.sql`, `0006_reliability_and_audit.sql`, `0007_force_manager_password_rotation.sql`
- Android: `android/app/build.gradle`, `android/app/proguard-rules.pro`, `android/app/src/main/AndroidManifest.xml`, `android/signing.properties.example`, `scripts/build-android-release.ps1`, `app-version.json`
- Tests/benchmarks: `tests/migration.test.mjs`, `tests/money.test.mjs`, `tests/server.test.mjs`, `tests/worker-d1.test.mjs`, `tests/workspace.spec.mjs`, `scripts/pos-load-test.mjs`, `scripts/benchmark-db.mjs`
- Operations: `.github/workflows/ci.yml`, `.github/workflows/d1-backup.yml`, `scripts/backup-d1.mjs`, `scripts/verify-d1-backup.mjs`, `docs/BACKUP_AND_RESTORE.md`, `docs/ANDROID_RELEASE.md`

## 2. Database migrations

`0005` rebuilt `orders` and `order_items` without losing IDs, timestamps, lines, indexes, or foreign keys and extended the status constraint with `cancelled`.

`0006` added order versions/timestamps/cancellation attribution, payment status/correction attribution, explicit `payment_orders` links, payroll snapshots, session metadata, durable login-attempt state, state versions, audit events, and measured indexes.

`0007` marked existing managers for mandatory password rotation. Production shows all seven migrations and `PRAGMA foreign_key_check` returns no rows.

## 3. Fixed bugs

- Production D1 accepts `cancelled`; cancellation remains in history, releases a table when no active bill remains, and cannot be paid.
- Android offline initialization creates both cache and outbox tables.
- Node writes are serialized to avoid lost updates during concurrent rush traffic.
- Order and payment actions require mutation IDs. Order versions reject stale offline replay.
- Exactly one of two simultaneous payment attempts succeeds.
- Incorrect payments can be voided/refunded by a manager with a reason without deleting the original record.

## 4. Architecture

Normalized D1 tables are now the primary source of truth. The Worker no longer updates the legacy JSON row and no longer deletes/reinserts every restaurant table for each action. It computes the validated next state but writes only changed rows in one D1 batch. The legacy row is read only and retained for recovery compatibility.

Clients poll `/api/version`; they fetch role state only after its version changes. Failure automatically falls back to the proven full-state poll. The Durable Object remains the production write serializer and D1 remains the source of truth.

## 5. Order reliability

- Create, advance, cancel, serve, and payment mutations have 128-bit mutation IDs.
- D1 stores processed IDs for 30 days; offline order IDs are deterministic from the mutation ID.
- Orders have optimistic versions and stale offline actions remain queued with a visible conflict.
- The UI shows online/offline, syncing, pending count, last successful sync, failures, and retry.
- Kitchen/waiter notification delivery uses version polling with full-state fallback. Notifications never determine persistence.

## 6. Payment reliability

- Payment totals use shared, tested two-decimal rounding.
- D1 batches payment, payment lines, order links, paid order versions, table release, audit, version, and mutation ID atomically.
- Concurrent tests produced one payment per table and no duplicates.
- New payments link directly to settled order IDs. Pre-migration payments retain snapshots but have no inferred links.

## 7. Android release

- Version: `1.6` (`versionCode 7`)
- Artifact: `downloads/Sajilo-Restaurant-release.apk`
- SHA-256: `efa76f93d82eb699c08895246c7fac9d4c97e3302139b7f3265f12f2b0721fc3`
- Signature: APK Signature Scheme v2 verified, RSA 4096-bit release key
- `debuggable` absent/false, R8 minification and resource shrinking enabled, production Worker URL bundled
- Moving from the previously published debug-signed APK requires a one-time uninstall after all pending offline work has synchronized. Android blocks in-place updates across different signing keys. Later releases update in place when signed with the same protected key.
- Android backup and cleartext traffic disabled
- Keystore and passwords are ignored by Git. They require a separate encrypted backup.

Physical-device installation, background/foreground behavior, and a real Android offline/reconnect cycle are **NOT TESTED** in this environment.

## 8. Security

Resolved: named manager accounts, 12-character new-password minimum, forced legacy-manager rotation, scrypt hashes, hashed session tokens, HttpOnly cookies, session revocation, account suspension, durable D1 login throttling, request IDs, CSP/HSTS/Permissions-Policy/referrer/nosniff headers, no plaintext password display, and immutable audit events.

Production manager `prabesh` is marked to change the legacy password at next sign-in. Restaurant actions remain blocked until rotation succeeds.

## 9. Performance

Local isolated Node/SQLite benchmark; Cloudflare network latency is not represented.

| Scenario | Users | Target RPS | p50 | p95 | p99 | Errors |
|---|---:|---:|---:|---:|---:|---:|
| Normal rush | 13 | 15 | 19.57 ms | 125.32 ms | 276.30 ms | 0 |
| Heavy rush | 13 | 30 | 19.60 ms | 173.28 ms | 299.82 ms | 0 |
| Extreme short burst | 13 | 75 | 15.69 ms | 115.59 ms | 317.27 ms | 0 |

Each run executed 40 orders over 20 tables, kitchen-ready, waiter-served, duplicate create retries, 20 simultaneous two-request payment races, and manager reads. Each finished with 40 unique orders, 20 payments, zero duplicates, zero lost orders, and zero invalid states.

## 10. Database performance

SQLite 10,000-order/8,000-payment microbenchmark:

- Active-order indexed query: 0.0024 ms average; forced scan: 0.3266 ms.
- Indexed sales date range: 0.3938 ms average; forced scan: 0.6290 ms.
- One-row incremental mutation: 0.0675 ms; emulated full 10,000-order rewrite: 80.5854 ms.
- Query plans confirmed order and payment date indexes. These are local microbenchmarks, not Cloudflare production latency measurements.

## 11. Remaining issues

### Critical

None found in the tested code and production schema.

### High

- The manager must complete the required password rotation before operating the restaurant.
- Install and exercise the signed APK on a real Android device online, fully offline, after process termination, and after reconnect before staff rollout. **NOT TESTED**.
- Add `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` GitHub secrets and manually verify the scheduled backup workflow once. Local production exports were restored and passed integrity checks.

### Medium

- Orders, sales, and payroll still arrive in a role snapshot after a version change. Audit events are paginated; history/report pagination should be migrated next as data grows.
- Historic payments from before `0006` cannot be linked to exact order IDs without unreliable inference.
- Durable money columns remain `REAL`; strict shared rounding is tested. The staged paisa migration is documented in `docs/MONEY_PRECISION.md`.
- Firefox and WebKit/Safari automation are **NOT TESTED**. Chrome passed at 320, 375, 390, 414, 768, 1024, 1366, and 1920 CSS pixels.

### Low

- Android Gradle reports deprecated features for future Gradle 9 compatibility and cannot strip SQLCipher native debug symbols.

## 12. Production readiness

- Cancellation fixed: **Yes**, deployed and schema-verified.
- D1 mutations incremental: **Yes**.
- Waiter orders reach kitchen reliably: **Yes in automated browser/contract tests**, with database truth and polling fallback.
- Duplicate payments prevented: **Yes**.
- Offline replay avoids duplicates: **Yes**, mutation IDs plus deterministic IDs; conflicts remain pending.
- Android release-signed: **Yes**.
- Audit logging implemented: **Yes**.
- Backups configured: **Workflow configured; GitHub secrets/first scheduled run remain**. Manual pre/post/final exports restored successfully.
- Monitoring configured: **Structured Worker logs, request IDs, Cloudflare observability, and D1 health endpoint are active**. External alert destinations remain operational configuration.

The web system and D1 migration are suitable for a controlled single-restaurant rollout after manager password rotation. Complete the real-device Android and scheduled-backup checks before relying on the APK for live service.
