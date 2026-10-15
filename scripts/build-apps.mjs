#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/ext-apps";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appDir = path.join(repo, "src", "apps");
const apps = [
  { name: "apply-patch", title: "Apply Patch Diff" },
  { name: "command-result", title: "Command Result" },
  { name: "skills-browser", title: "Skills Browser" },
  { name: "todos", title: "Todos" },
  { name: "file-preview", title: "Display" },
  { name: "image-preview", title: "Image Preview" },
];

for (const app of apps) {
  const result = await build({
    entryPoints: [path.join(appDir, `${app.name}.js`)],
    bundle: true,
    write: false,
    minify: true,
    format: "iife",
    platform: "browser",
    target: ["es2022"],
    define: { __MCP_APP_PROTOCOL_VERSION__: JSON.stringify(LATEST_PROTOCOL_VERSION) },
  });

  const js = result.outputFiles[0].text.replaceAll("</script", "<\\/script");
  const css = await fs.readFile(path.join(appDir, `${app.name}.css`), "utf8");
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${app.title}</title>
<style>${css}</style>
</head>
<body>
<div id="root"></div>
<script>${js}</script>
</body>
</html>
`;
  const output = path.join(appDir, `${app.name}.html`);
  await fs.writeFile(output, html, "utf8");
  console.log(`built src/apps/${app.name}.html (${Buffer.byteLength(html)} bytes)`);
}
