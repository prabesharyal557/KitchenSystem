import { cpSync, mkdirSync, rmSync } from "node:fs";

const output = "mobile-www";
rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });
for (const file of [
  "index.html",
  "manager.html",
  "waiter.html",
  "kitchen.html",
  "app.js",
  "sw.js",
  "manifest.webmanifest",
  "style.css",
  "auth.css",
  "favicon.svg",
  "apple-touch-icon.png",
]) {
  cpSync(file, `${output}/${file}`);
}
