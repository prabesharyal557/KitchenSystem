export async function backupCloudflareDatabase(
  source: D1Database,
  backup: D1Database,
) {
  const schema = await source
    .prepare(
      "SELECT type, name, sql FROM sqlite_master WHERE type IN ('table', 'index') AND sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY type DESC, name",
    )
    .all<{ type: string; name: string; sql: string }>();
  const tables = schema.results.filter((entry) => entry.type === "table");
  const data = await source.batch(
    tables.map(({ name }) =>
      source.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`),
    ),
  );
  if (data.some((result) => !result.success))
    throw new Error("Database backup read failed");
  const createdAt = new Date().toISOString();
  const body = JSON.stringify({
    format: 1,
    createdAt,
    schema: schema.results,
    tables: tables.map((table, index) => ({
      name: table.name,
      rows: data[index].results,
    })),
  });
  await backup
    .prepare(
      "CREATE TABLE IF NOT EXISTS snapshots (id TEXT PRIMARY KEY, created_at TEXT NOT NULL)",
    )
    .run();
  await backup
    .prepare(
      "CREATE TABLE IF NOT EXISTS snapshot_chunks (snapshot_id TEXT NOT NULL, part INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(snapshot_id, part))",
    )
    .run();
  const statements = [
    backup
      .prepare("INSERT INTO snapshots (id, created_at) VALUES (?, ?)")
      .bind(createdAt, createdAt),
  ];
  for (let offset = 0, part = 0; offset < body.length; offset += 64000, part++)
    statements.push(
      backup
        .prepare("INSERT INTO snapshot_chunks VALUES (?, ?, ?)")
        .bind(createdAt, part, body.slice(offset, offset + 64000)),
    );
  const cutoff = new Date(Date.now() - 30 * 86400000).toISOString();
  statements.push(
    backup
      .prepare(
        "DELETE FROM snapshot_chunks WHERE snapshot_id IN (SELECT id FROM snapshots WHERE created_at < ?)",
      )
      .bind(cutoff),
  );
  statements.push(
    backup.prepare("DELETE FROM snapshots WHERE created_at < ?").bind(cutoff),
  );
  await backup.batch(statements);
  return { createdAt, tables: tables.length };
}
