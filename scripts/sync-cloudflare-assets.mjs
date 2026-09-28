import { access, cp, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const output = join(root, "cloudflare-public");
await rm(output, { recursive: true, force: true });
await mkdir(join(output, "download"), { recursive: true });
for (const file of [
  "index.html",
  "manager.html",
  "waiter.html",
  "kitchen.html",
  "terms.html",
  "privacy.html",
  "app.js",
  "app-version.json",
  "sw.js",
  "manifest.webmanifest",
  "style.css",
  "auth.css",
  "favicon.svg",
  "apple-touch-icon.png",
]) {
  await cp(join(root, file), join(output, file));
}
const release = join(root, "downloads", "Sajilo-Restaurant-release.apk");
await access(release).catch(() => {
  throw new Error(
    "Production deployment requires downloads/Sajilo-Restaurant-release.apk. Run npm run android:release first.",
  );
});
await cp(release, join(output, "download", "Sajilo-Restaurant-release.apk"));
await cp(
  `${release}.sha256`,
  join(output, "download", "Sajilo-Restaurant-release.apk.sha256"),
);
console.log("Cloudflare website assets are ready.");
