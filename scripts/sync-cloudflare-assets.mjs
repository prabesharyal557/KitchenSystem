import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const output = join(root, "cloudflare-public");
await rm(output, { recursive: true, force: true });
await mkdir(join(output, "download"), { recursive: true });
for (const file of ["index.html", "manager.html", "waiter.html", "kitchen.html", "terms.html", "privacy.html", "app.js", "app-version.json", "sw.js", "manifest.webmanifest", "style.css", "auth.css", "favicon.svg", "apple-touch-icon.png"]) {
  await cp(join(root, file), join(output, file));
}
await cp(join(root, "downloads", "Sajilo-Restaurant.apk"), join(output, "download", "app-debug.apk"));
console.log("Cloudflare website assets are ready.");
