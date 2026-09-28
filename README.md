# Sajilo restaurant workspace

Run with Node.js 24 or later:

```powershell
npm start
```

For development, run `npm run dev` to automatically restart the server when its source files change. Refresh the browser after frontend edits.

Multiple staff can sign in simultaneously on separate devices or in separate browser tabs. Open the sign-in page in a new tab for each person; each successful login receives an independent session. Refreshing a tab preserves its account, and signing out affects only that session. Duplicating an already signed-in tab initially shares that session until you sign in to another account in the new tab. Password resets, suspension and restaurant closure still revoke the affected staff sessions across all devices. Terms and Conditions and Privacy Policy pages remain available, but acceptance is temporarily disabled.

The production sign-in page is at <https://sajilo-restaurant.aryalprabesh300.workers.dev>. Add waiter or additional manager accounts in **Staff & payroll**. Run integration checks with `npm test`.

For development checks, run `npm ci`, then `npm run typecheck` and `npm run test:ui`. The browser tests use an installed Chrome and an isolated temporary database; they do not add demo accounts or sales to your restaurant database.

## Included

- Redesigned responsive manager and waiter screens.
- Clickable overview metrics; sales and completed-bill reports for day, Monday–Sunday week, month and year, with a date picker. Dates use Nepal time.
- Actual paid sales, tax, net sales, estimated gross profit, average bill and best sellers. Gross profit subtracts recorded ingredient costs, not payroll, rent or other operating expenses.
- Shared tables and order progression. Clients check a lightweight version every four seconds and fetch role data only when it changes; the existing full-state poll remains as an automatic fallback. Available, busy and pending/reserved table states. Unpaid tables cannot be deleted or freed.
- Kitchen staff see active kitchen tickets and can only mark new orders ready. Managers can also mark food ready; waiters alone mark ready orders served. Waiters receive notifications for ready-to-serve and served orders. Legacy preparing tickets remain visible under New orders.
- Managers and kitchen staff receive new-order alerts; waiters receive ready-to-serve and served alerts with table numbers and items. In-app alerts work while typing. Use **Enable sound & desktop alerts** for sound and browser notifications. Keep the app open; desktop alerts require browser permission/support. Repeated polling and reloads do not duplicate alerts in the same tab.
- Menu CRUD, categories, availability and custom/name/price sorting. Order lines retain their price and cost when the menu changes.
- Individual named manager/staff accounts, strong passwords, role permissions, suspension, password rotation, session revocation, and salary/advance ledgers. Each staff payment snapshots salary and remaining balance for its month.
- Manager-controlled closure revokes waiter sessions. Reopening allows active accounts to sign in again.
- Editable tax rate on unsettled bills; paid bills retain the original rate. Payment verifies the reviewed total and requires all tickets to be served. Cash/QR/Card record payments already collected; they do not process a payment gateway transaction.
- Choosing Cash, QR or Card opens a confirmation inside the bill. **Confirm payment** records it; **Back to bill** cancels the confirmation without taking payment. Managers can void/refund an incorrect record with a required reason; the original payment remains in the audit history and is linked to its orders.
- Online orders placeholder directly below Overview.

## Architecture and data

Cloudflare Workers serves the production app and API, and Cloudflare D1 is its persistent cloud database. Normalized D1 tables are the source of truth. Each mutation inserts or updates only its affected order, item, table, payment, user, or setting rows in one D1 batch; it does not delete and recreate the restaurant. The legacy JSON row is read only and retained temporarily for migration recovery. A Durable Object serializes simultaneous writes. State versions avoid unchanged payload downloads, and API polling remains the delivery fallback. Mutation IDs and order versions prevent duplicate/replayed writes and detect offline conflicts. Important manager, order, payment, payroll, settings, login, and access changes append immutable audit events.

The Android app has a private SQLite cache and outbox. The server owns authorization, transitions, price calculation, and atomic writes. Passwords use salted scrypt; random session tokens are stored only as hashes and delivered in HttpOnly cookies. Production login throttling persists in D1. See [backup and restore](docs/BACKUP_AND_RESTORE.md) and [Android release](docs/ANDROID_RELEASE.md).

Deploy production updates with `npm run cloudflare:deploy`. The Worker configuration and D1 binding are in `wrangler.jsonc`; schema changes belong in `migrations/`.

The old browser-local demo is not imported automatically: it contained fabricated totals and undated records. Existing localStorage data is left untouched. Fresh server state has sample menu names/prices and twelve available tables, but **no invented orders, sales or payroll**. Set real ingredient costs before relying on profit reports.

## Other devices / hosting

To use several devices on the same trusted Wi-Fi/LAN, stop the existing server with Ctrl+C and run `npm run dev:lan`. On the server computer run `ipconfig` to find its LAN IPv4 address, then open `http://<that-address>:3000` on each device and sign in individually. `localhost` on a phone points to the phone, not this server. Windows Firewall may need to allow Node.js on the private network. Complete first-manager setup on the server computer before connecting other devices.

## Android APK

Run `npm run android:debug` only for development. For staff distribution, complete the signing setup in [docs/ANDROID_RELEASE.md](docs/ANDROID_RELEASE.md) and run `npm run android:release`. The release build disables debugging, uses R8/resource shrinking, produces a SHA-256 checksum, and bundles the screens so the app can start offline. Android backup is disabled for its session, cached restaurant data, and pending outbox.

Android releases use `app-version.json` as the update manifest. The installed app compares its bundled copy with Cloudflare at startup, when connectivity returns, and every six hours. Increase `versionCode` and `versionName`, build with the same protected release key, verify the signature/hash, test on staging, and deploy. Users receive an in-app update notice without deleting their current installation. Moving from the previously published debug-signed APK to version 1.5 requires staff to sync pending work and uninstall the old app once because Android does not permit an in-place update signed by a different key. Releases after 1.5 update in place when they use the same protected release key.

Download the published release APK from <https://sajilo-restaurant.aryalprabesh300.workers.dev/download/Sajilo-Restaurant-release.apk>.

On iPhone or iPad, open <https://sajilo-restaurant.aryalprabesh300.workers.dev> in Safari, tap **Share**, choose **Add to Home Screen**, and open Sajilo from the new home-screen icon. iOS cannot install Android APK files. The home-screen app receives website updates automatically and uses IndexedDB for the same offline order queue.

Open the app with internet and sign in once before going offline. The installed app then keeps its screens and latest workspace in local SQLite. While offline, managers and waiters can create orders, kitchen staff and managers can mark orders ready, and waiters can mark ready orders served. Pending changes sync automatically in their original order when internet returns; unique mutation IDs make retries safe.

Staff, password, menu, table, payroll, payment and restaurant-setting changes require internet because they need current authorization and server totals. The header shows online/offline state, last sync, pending count, conflicts, and a retry control. Do not clear app storage while pending work exists. Account suspension or restaurant closure reaches an offline phone after it reconnects.

The default local server listens only on `127.0.0.1`. Production uses Cloudflare. Daily verified D1 exports are configured in `.github/workflows/d1-backup.yml`; add the documented repository secrets and run the workflow once manually to activate and verify it.

Managers can create kitchen accounts in **Staff & payroll**. Kitchen accounts only receive the active order list and cannot access tables, menu management, payments, sales, payroll or settings.

## Free hosted trial

`render.yaml` can deploy the app on Render's free plan for testing staff phones over HTTPS. Its SQLite database is stored in temporary service storage, so a restart or redeploy can erase accounts, orders, sales and payments. Use it only for trials; a production restaurant needs persistent storage.
