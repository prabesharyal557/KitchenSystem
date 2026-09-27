# Sajilo restaurant workspace

Run with Node.js 24 or later:

```powershell
npm start
```

For development, run `npm run dev` to automatically restart the server when its source files change. Refresh the browser after frontend edits.

Multiple staff can sign in simultaneously on separate devices or in separate browser tabs. Open the sign-in page in a new tab for each person; each successful login receives an independent session. Refreshing a tab preserves its account, and signing out affects only that session. Duplicating an already signed-in tab initially shares that session until you sign in to another account in the new tab. Password resets, suspension and restaurant closure still revoke the affected staff sessions across all devices.

The production sign-in page is at <https://sajilo-restaurant.aryalprabesh300.workers.dev>. Add waiter or additional manager accounts in **Staff & payroll**. Run integration checks with `npm test`.

For development checks, run `npm ci`, then `npm run typecheck` and `npm run test:ui`. The browser tests use an installed Chrome and an isolated temporary database; they do not add demo accounts or sales to your restaurant database.

## Included

- Redesigned responsive manager and waiter screens.
- Clickable overview metrics; sales and completed-bill reports for day, Monday–Sunday week, month and year, with a date picker. Dates use Nepal time.
- Actual paid sales, tax, net sales, estimated gross profit, average bill and best sellers. Gross profit subtracts recorded ingredient costs, not payroll, rent or other operating expenses.
- Shared tables and order progression, refreshed every four seconds. Available, busy and pending/reserved table states. Unpaid tables cannot be deleted or freed.
- Kitchen staff see active kitchen tickets and can only mark new orders ready. Managers can also mark food ready; waiters alone mark ready orders served. Waiters receive notifications for ready-to-serve and served orders. Legacy preparing tickets remain visible under New orders.
- Managers and kitchen staff receive new-order alerts; waiters receive ready-to-serve and served alerts with table numbers and items. In-app alerts work while typing. Use **Enable sound & desktop alerts** for sound and browser notifications. Keep the app open; desktop alerts require browser permission/support. Repeated polling and reloads do not duplicate alerts in the same tab.
- Menu CRUD, categories, availability and custom/name/price sorting. Order lines retain their price and cost when the menu changes.
- Individual staff accounts, role permissions, suspension and password resets; salary and advance payment ledger by salary month. Remaining balance uses the current monthly salary. Payments are immutable in this version.
- Manager-controlled closure revokes waiter sessions. Reopening allows active accounts to sign in again.
- Editable tax rate on unsettled bills; paid bills retain the original rate. Payment verifies the reviewed total and requires all tickets to be served. Cash/QR/Card record payments already collected; they do not process a payment gateway transaction.
- Choosing Cash, QR or Card opens a confirmation inside the bill. **Confirm payment** records it; **Back to bill** cancels the confirmation without taking payment.
- Online orders placeholder directly below Overview.

## Architecture and data

Cloudflare Workers serves the production app and API, and Cloudflare D1 is its persistent cloud database for restaurant state, password hashes and sessions. A Durable Object serializes updates from simultaneous staff devices. The Android app also has a private SQLite database for its cached workspace and pending offline actions. The server owns authorization, validation, price calculation and atomic writes. Passwords use salted scrypt; sessions use random, hashed tokens and HttpOnly cookies. The app escapes user text and enforces a restrictive Content Security Policy.

Deploy production updates with `npm run cloudflare:deploy`. The Worker configuration and D1 binding are in `wrangler.jsonc`; schema changes belong in `migrations/`.

The old browser-local demo is not imported automatically: it contained fabricated totals and undated records. Existing localStorage data is left untouched. Fresh server state has sample menu names/prices and twelve available tables, but **no invented orders, sales or payroll**. Set real ingredient costs before relying on profit reports.

## Other devices / hosting

To use several devices on the same trusted Wi-Fi/LAN, stop the existing server with Ctrl+C and run `npm run dev:lan`. On the server computer run `ipconfig` to find its LAN IPv4 address, then open `http://<that-address>:3000` on each device and sign in individually. `localhost` on a phone points to the phone, not this server. Windows Firewall may need to allow Node.js on the private network. Complete first-manager setup on the server computer before connecting other devices.

## Android APK

Run `npm run android:debug` with JDK 21 to create `android/app/build/outputs/apk/debug/app-debug.apk`. New APK installs connect to the Cloudflare production site automatically, so a restaurant computer does not need to remain running.

Download the published APK from <https://sajilo-restaurant.aryalprabesh300.workers.dev/download/app-debug.apk>.

Open the app with internet and sign in once before going offline. The installed app then keeps its screens and latest workspace in local SQLite. While offline, managers and waiters can create orders, kitchen staff and managers can mark orders ready, and waiters can mark ready orders served. Pending changes sync automatically in their original order when internet returns; unique mutation IDs make retries safe.

Staff, password, menu, table, payroll, payment and restaurant-setting changes still require internet because these operations need current authorization and server totals. Do not clear the Android app's storage while it has unsynced work. Account suspension or restaurant closure reaches an offline phone after it reconnects.

The default server listens only on `127.0.0.1`. After local setup, a trusted-network deployment can set `HOST=0.0.0.0`; point every device at this one server. Use HTTPS via a reverse proxy and set `SECURE_COOKIE=1` for a hosted deployment. `PORT` defaults to 3000, and `DATA_DIR` can point to persistent storage. Do not run multiple processes against this application database; this version is designed for one restaurant/server process. Back up the database (stop the server before copying the data directory, or use SQLite's backup facility). This repository includes no hosting or automated backup setup.

Managers can create kitchen accounts in **Staff & payroll**. Kitchen accounts only receive the active order list and cannot access tables, menu management, payments, sales, payroll or settings.

## Free hosted trial

`render.yaml` can deploy the app on Render's free plan for testing staff phones over HTTPS. Its SQLite database is stored in temporary service storage, so a restart or redeploy can erase accounts, orders, sales and payments. Use it only for trials; a production restaurant needs persistent storage.
