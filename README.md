# Sajilo restaurant workspace

Run with Node.js 24 or later:

```powershell
npm start
```

For development, run `npm run dev` to automatically restart the server when its source files change. Refresh the browser after frontend edits.

Multiple staff can sign in simultaneously on separate devices or in separate browser tabs. Open the sign-in page in a new tab for each person; each successful login receives an independent session. Refreshing a tab preserves its account, and signing out affects only that session. Duplicating an already signed-in tab initially shares that session until you sign in to another account in the new tab. Password resets, suspension and restaurant closure still revoke the affected staff sessions across all devices.

Open http://127.0.0.1:3000 on the server computer and create the first manager account. There are no shared demo PINs. Initial manager setup is allowed only from localhost. Add waiter or additional manager accounts in **Staff & payroll**. Run integration checks with `npm test`.

For development checks, run `npm ci`, then `npm run typecheck` and `npm run test:ui`. The browser tests use an installed Chrome and an isolated temporary database; they do not add demo accounts or sales to your restaurant database.

## Included

- Redesigned responsive manager and waiter screens.
- Clickable overview metrics; sales and completed-bill reports for day, Monday–Sunday week, month and year, with a date picker. Dates use Nepal time.
- Actual paid sales, tax, net sales, estimated gross profit, average bill and best sellers. Gross profit subtracts recorded ingredient costs, not payroll, rent or other operating expenses.
- Shared tables and order progression, refreshed every four seconds. Available, busy and pending/reserved table states. Unpaid tables cannot be deleted or freed.
- Managers handle orders in **New orders** and **Ready to serve**. Managers mark food ready; waiters alone mark ready orders served. Waiters receive notifications for ready-to-serve and served orders. Legacy preparing tickets remain visible under New orders.
- Managers receive new-order alerts; waiters receive ready-to-serve and served alerts with table numbers and items. In-app alerts work while typing. Use **Enable sound & desktop alerts** for sound and browser notifications. Keep the app open; desktop alerts require browser permission/support. Repeated polling and reloads do not duplicate alerts in the same tab.
- Menu CRUD, categories, availability and custom/name/price sorting. Order lines retain their price and cost when the menu changes.
- Individual staff accounts, role permissions, suspension and password resets; salary and advance payment ledger by salary month. Remaining balance uses the current monthly salary. Payments are immutable in this version.
- Manager-controlled closure revokes waiter sessions. Reopening allows active accounts to sign in again.
- Editable tax rate on unsettled bills; paid bills retain the original rate. Payment verifies the reviewed total and requires all tickets to be served. Cash/QR/Card record payments already collected; they do not process a payment gateway transaction.
- Choosing Cash, QR or Card opens a confirmation inside the bill. **Confirm payment** records it; **Back to bill** cancels the confirmation without taking payment.
- Online orders placeholder directly below Overview.

## Architecture and data

`server.ts` is a TypeScript HTTP backend running on Node's native type-stripping runtime. The browser remains standards-based JavaScript/CSS. SQLite stores shared restaurant state, password hashes and session tokens in `data/sajilo.sqlite`. No third-party runtime packages are required. The server owns authorization, validation, price calculation and atomic writes. Passwords use salted scrypt; sessions use random, hashed tokens and HttpOnly/SameSite cookies. The app escapes user text and enforces a restrictive Content Security Policy.

The old browser-local demo is not imported automatically: it contained fabricated totals and undated records. Existing localStorage data is left untouched. Fresh server state has sample menu names/prices and twelve available tables, but **no invented orders, sales or payroll**. Set real ingredient costs before relying on profit reports.

## Other devices / hosting

To use several devices on the same trusted Wi-Fi/LAN, stop the existing server with Ctrl+C and run `npm run dev:lan`. On the server computer run `ipconfig` to find its LAN IPv4 address, then open `http://<that-address>:3000` on each device and sign in individually. `localhost` on a phone points to the phone, not this server. Windows Firewall may need to allow Node.js on the private network. Complete first-manager setup on the server computer before connecting other devices.

## Android APK

Run `npm run android:debug` to create `android/app/build/outputs/apk/debug/app-debug.apk`. Install this APK, then enter the restaurant computer's LAN address, for example `http://192.168.1.10:3000`. Start the server first with `npm run dev:lan`; both devices must be on the same trusted Wi-Fi. The APK allows HTTP only for a local restaurant network. Use HTTPS before using it over the internet.

After a website deployment, download the published APK from `/download/app-debug.apk` on the restaurant website.

The default server listens only on `127.0.0.1`. After local setup, a trusted-network deployment can set `HOST=0.0.0.0`; point every device at this one server. Use HTTPS via a reverse proxy and set `SECURE_COOKIE=1` for a hosted deployment. `PORT` defaults to 3000, and `DATA_DIR` can point to persistent storage. Do not run multiple processes against this application database; this version is designed for one restaurant/server process. Back up the database (stop the server before copying the data directory, or use SQLite's backup facility). This repository includes no hosting or automated backup setup.

The separate kitchen workspace and new kitchen accounts have been removed. Existing kitchen staff records and payroll remain available to managers, but kitchen-role sign-in and old kitchen sessions are blocked. A manager can reassign a former kitchen account to an available role.

## Free hosted trial

`render.yaml` can deploy the app on Render's free plan for testing staff phones over HTTPS. Its SQLite database is stored in temporary service storage, so a restart or redeploy can erase accounts, orders, sales and payments. Use it only for trials; a production restaurant needs persistent storage.
