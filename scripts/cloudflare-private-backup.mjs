import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { backupCloudflareDatabase } from "../cloudflare-backup.ts";

const directory = resolve("backups");
mkdirSync(directory, { recursive: true });
const stamp = new Date().toISOString().replaceAll(":", "-");
const exportFile = resolve(directory, `cloudflare-${stamp}.sql`);
const wrangler = resolve("node_modules/wrangler/bin/wrangler.js");
function run(args) {
  return execFileSync(process.execPath, [wrangler, ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}
run(["d1", "export", "sajilo-restaurant", "--remote", "--output", exportFile]);
const database = new DatabaseSync(":memory:");
database.exec(readFileSync(exportFile, "utf8"));
if (database.prepare("PRAGMA integrity_check").get().integrity_check !== "ok")
  throw new Error("Backup integrity check failed");
const literal = (value) =>
  value === null
    ? "NULL"
    : typeof value === "number"
      ? String(value)
      : `'${String(value).replaceAll("'", "''")}'`;
function statement(sql, values = []) {
  return {
    sql,
    values,
    bind(...values) {
      return statement(sql, values);
    },
    async all() {
      return { success: true, results: database.prepare(sql).all(...values) };
    },
    async run() {
      return remote([this]);
    },
  };
}
function remote(statements) {
  const file = resolve(directory, "store-private-backup.sql");
  writeFileSync(
    file,
    statements
      .map(({ sql, values }) => {
        let index = 0;
        return sql.replaceAll("?", () => literal(values[index++])) + ";";
      })
      .join("\n"),
  );
  run([
    "d1",
    "execute",
    "sajilo-restaurant-backups",
    "--remote",
    "--file",
    file,
  ]);
  return [];
}
try {
  const result = await backupCloudflareDatabase(
    {
      prepare: statement,
      async batch(statements) {
        database.exec("BEGIN");
        try {
          const result = statements.map(({ sql, values }) => ({
            success: true,
            results: database.prepare(sql).all(...values),
          }));
          database.exec("COMMIT");
          return result;
        } catch (error) {
          database.exec("ROLLBACK");
          throw error;
        }
      },
    },
    { prepare: statement, batch: remote },
  );
  console.log(
    JSON.stringify({
      backupStoredInCloudflare: true,
      ...result,
      localExport: exportFile,
    }),
  );
} finally {
  database.close();
}
