import { backupCloudflareDatabase } from "./cloudflare-backup.ts";

type BackupEnv = { DB: D1Database; BACKUP_DB: D1Database };
export default {
  async scheduled(_event: ScheduledController, env: BackupEnv) {
    const result = await backupCloudflareDatabase(env.DB, env.BACKUP_DB);
    console.log(JSON.stringify({ action: "backup.completed", ...result }));
  },
  async fetch() {
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<BackupEnv>;
