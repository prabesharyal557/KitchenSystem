import { cpSync, mkdirSync, rmSync } from "node:fs";

const output = "mobile-www";
rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });
for (const file of ["index.html", "app.js", "style.css", "auth.css", "favicon.svg"]) {
  cpSync(file, `${output}/${file}`);
}
