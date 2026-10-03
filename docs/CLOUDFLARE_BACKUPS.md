# Cloudflare storage and recovery

The restaurant uses the existing `sajilo-restaurant` D1 database. Worker and Android updates do not replace this database or its account password hashes.

The separate `sajilo-restaurant-backup` worker runs hourly and writes consistent copies of the database to private `sajilo-restaurant-backups` D1 storage. Copies include credentials, restaurant records, audit records, and schema indexes. Copies are retained for 30 days. No public route exposes backups. Cloudflare D1 Time Travel provides an additional recovery option.

Before changing production, create and verify a backup:

```powershell
node scripts/cloudflare-private-backup.mjs
node scripts/recover-cloudflare-backup.mjs
```

The recovery command downloads the latest private snapshot and verifies its SQLite integrity and foreign keys. It saves a private SQL file in the ignored `backups` folder without modifying production. Pass an ISO snapshot timestamp as its first argument to recover an older copy. Restore the SQL into a new D1 database and verify it before changing the production binding. Backups contain password hashes and private business records; never commit or publicly upload them.

The Render compatibility service can use `CLOUDFLARE_ORIGIN=https://sajilo-restaurant.aryalprabesh300.workers.dev`. Website visits redirect to Cloudflare, and old Android API requests are forwarded to Cloudflare. Render's temporary SQLite database is then no longer the restaurant's data source.

Backups are recovery copies, not a guarantee against every loss. An hourly copy can miss changes since the last successful backup. Check worker logs for `backup.completed` and retain an independent offline export before migrations. Unsynced offline orders still need the device to reconnect and upload.
