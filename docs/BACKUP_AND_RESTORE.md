# D1 backup and restore runbook

Target recovery point objective (RPO): **24 hours**. Target recovery time objective (RTO): **4 hours**.

The `D1 production backup` GitHub Actions workflow runs daily, creates an independent logical SQL export, restores it into temporary SQLite, runs `PRAGMA integrity_check`, reports table row counts, and retains the verified artifact for 35 days. Configure repository secrets `CLOUDFLARE_API_TOKEN` (D1 read permission) and `CLOUDFLARE_ACCOUNT_ID`. Test the workflow manually after configuring the secrets.

Cloudflare D1 Time Travel is an additional recovery layer. Record a bookmark before every migration or production release. It does not replace the independent export.

## Manual backup and verification

```powershell
npm run backup:d1 -- sajilo-restaurant backups/manual.sql
node scripts/verify-d1-backup.mjs backups/manual.sql
Get-FileHash backups/manual.sql -Algorithm SHA256
```

Store a copy outside the Cloudflare account and development computer.

## Restore rehearsal

Never rehearse against production. Create a new staging D1 database, inspect the export, execute it against staging, bind a staging Worker to that database, then run the Worker/D1 contract and browser tests. Compare table counts, recent orders, payments, payment-to-order links, staff, and audit events with the backup verification output.

For a real incident, stop writes by closing restaurant access, take a final export if D1 remains readable, choose the latest verified backup or Time Travel bookmark, restore to a new D1 database first, validate it, then change the production binding. Keep the damaged database unchanged until financial and order records are reconciled.
