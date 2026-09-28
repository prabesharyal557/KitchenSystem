import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const input = resolve(process.argv[2] || "");
if (!process.argv[2])
  throw new Error("Usage: node scripts/verify-d1-backup.mjs <backup.sql>");
const directory = mkdtempSync(join(tmpdir(), "sajilo-backup-verify-"));
const database = new DatabaseSync(join(directory, "restore.sqlite"));

try {
  database.exec(readFileSync(input, "utf8"));
  const integrity = database
    .prepare("PRAGMA integrity_check")
    .get().integrity_check;
  const tables = database
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all()
    .map(({ name }) => ({
      name,
      rows: database
        .prepare(`SELECT COUNT(*) count FROM "${name.replaceAll('"', '""')}"`)
        .get().count,
    }));
  console.log(JSON.stringify({ integrity, tables }));
} finally {
  database.close();
  rmSync(directory, { recursive: true, force: true });
}
