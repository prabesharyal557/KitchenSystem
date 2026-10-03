import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const requested = process.argv[2];
const literal = (value) =>
  value === null
    ? "NULL"
    : typeof value === "number"
      ? String(value)
      : `'${String(value).replaceAll("'", "''")}'`;
const quote = (value) => `"${value.replaceAll('"', '""')}"`;
const query = (sql) =>
  JSON.parse(
    execFileSync(
      process.execPath,
      [
        resolve("node_modules/wrangler/bin/wrangler.js"),
        "d1",
        "execute",
        "sajilo-restaurant-backups",
        "--remote",
        "--json",
        "--command",
        sql,
      ],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    ),
  )[0].results;
const id =
  requested ||
  query("SELECT id FROM snapshots ORDER BY created_at DESC LIMIT 1")[0]?.id;
if (!id) throw new Error("No private backup exists");
const chunks = query(
  `SELECT body FROM snapshot_chunks WHERE snapshot_id = ${literal(id)} ORDER BY part`,
);
const backup = JSON.parse(chunks.map((entry) => entry.body).join(""));
if (backup.format !== 1) throw new Error("Unsupported backup format");
const lines = ["PRAGMA foreign_keys=OFF;"];
for (const entry of backup.schema.filter((entry) => entry.type === "table"))
  lines.push(entry.sql + ";");
for (const table of backup.tables)
  for (const row of table.rows) {
    const columns = Object.keys(row);
    lines.push(
      `INSERT INTO ${quote(table.name)} (${columns.map(quote).join(",")}) VALUES (${columns.map((key) => literal(row[key])).join(",")});`,
    );
  }
for (const entry of backup.schema.filter((entry) => entry.type === "index"))
  lines.push(entry.sql + ";");
const sql = lines.join("\n");
const database = new DatabaseSync(":memory:");
try {
  database.exec(sql);
  if (database.prepare("PRAGMA integrity_check").get().integrity_check !== "ok")
    throw new Error("Recovery integrity check failed");
  if (database.prepare("PRAGMA foreign_key_check").all().length)
    throw new Error("Recovery foreign-key check failed");
  mkdirSync("backups", { recursive: true });
  const output = resolve("backups", `recovered-${id.replaceAll(":", "-")}.sql`);
  writeFileSync(output, sql, { flag: "wx" });
  console.log(
    JSON.stringify({
      recoveryVerified: true,
      createdAt: backup.createdAt,
      tables: backup.tables.length,
      output,
    }),
  );
} finally {
  database.close();
}
