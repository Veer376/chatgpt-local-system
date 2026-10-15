import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceDir = path.join(repoRoot, "extensions", "local-system");
const outputDir = path.join(repoRoot, ".safari-ios", "extension");

const args = parseArgs(process.argv.slice(2));
const bridgeOrigin = normalizeOrigin(args.origin || process.env.SAFARI_BRIDGE_ORIGIN);
const username = String(args.username || process.env.SAFARI_BRIDGE_USERNAME || "local-system");
const password = readPassword(args);
const authorization = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;

fs.rmSync(outputDir, { recursive: true, force: true });
fs.mkdirSync(path.dirname(outputDir), { recursive: true });
fs.cpSync(sourceDir, outputDir, { recursive: true });

const manifestPath = path.join(outputDir, "manifest.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
manifest.host_permissions = Array.from(new Set([
  ...(manifest.host_permissions || []).filter((value) => !/^http:\/\/127\.0\.0\.1:8765\//.test(value)),
  `${bridgeOrigin}/*`,
]));
manifest.permissions = (manifest.permissions || []).filter((value) => value !== "notifications");
manifest.permissions = manifest.permissions.filter((value) => value !== "sidePanel");
delete manifest.side_panel;
for (const script of manifest.content_scripts || []) {
  delete script.world;
}
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

const bridgeFiles = ["background.js"];
const capabilityFetchFiles = ["annotations-content.js", "files.js", "viewer.js"];

for (const relative of bridgeFiles) {
  const filePath = path.join(outputDir, relative);
  let source = fs.readFileSync(filePath, "utf8");
  const bridgePattern = /const BRIDGE_ORIGINS\s*=\s*\["http:\/\/127\.0\.0\.1:8765"\];/;
  if (!bridgePattern.test(source)) {
    throw new Error(`expected BRIDGE_ORIGINS declaration in ${relative}`);
  }
  source = source.replace(
    bridgePattern,
    `const BRIDGE_ORIGINS = [${JSON.stringify(bridgeOrigin)}];\n${mobileFetchBootstrap(authorization, bridgeOrigin)}`,
  );
  source = source.replace(/AbortSignal\.timeout\(1_?[25]00\)/g, "AbortSignal.timeout(10_000)");
  source = source.replace(/AbortSignal\.timeout\(2_?[05]00\)/g, "AbortSignal.timeout(10_000)");
  source = source.replace(/AbortSignal\.timeout\(2500\)/g, "AbortSignal.timeout(10000)");
  source = source.replace(/setTimeout\(\(\)\s*=>\s*controller\.abort\(\),\s*2500\)/g, "setTimeout(() => controller.abort(), 10000)");
  fs.writeFileSync(filePath, source);
}

for (const relative of capabilityFetchFiles) {
  const filePath = path.join(outputDir, relative);
  const source = fs.readFileSync(filePath, "utf8");
  fs.writeFileSync(filePath, `${mobileFetchBootstrap(authorization, bridgeOrigin)}\n${source}`);
}

console.log(JSON.stringify({
  ok: true,
  outputDir,
  bridgeOrigin,
  filesPatched: bridgeFiles.length + capabilityFetchFiles.length,
}));

function mobileFetchBootstrap(authorizationValue, remoteOrigin) {
  return `const __LOCAL_SYSTEM_REMOTE_AUTHORIZATION = ${JSON.stringify(authorizationValue)};
const __LOCAL_SYSTEM_REMOTE_ORIGIN = ${JSON.stringify(remoteOrigin)};
const __localSystemNativeFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = function localSystemMobileFetch(input, init) {
  let url;
  try {
    const raw = input instanceof Request ? input.url : input;
    url = new URL(raw, globalThis.location?.href || __LOCAL_SYSTEM_REMOTE_ORIGIN);
  } catch {
    return __localSystemNativeFetch(input, init);
  }
  const isLoopback = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  const isBridge = url.origin === __LOCAL_SYSTEM_REMOTE_ORIGIN;
  if (!isLoopback && !isBridge) return __localSystemNativeFetch(input, init);
  const method = String(init?.method || (input instanceof Request ? input.method : "GET")).toUpperCase();
  const isCapabilityTicket = method === "GET"
    && (/^\\/local-file\\/[A-Za-z0-9_-]{20,}$/.test(url.pathname) || /^\\/local-image\\/[A-Za-z0-9_-]{20,}$/.test(url.pathname));
  if (isLoopback) {
    url = new URL(\`${"${url.pathname}${url.search}${url.hash}"}\`, __LOCAL_SYSTEM_REMOTE_ORIGIN);
  }
  const headers = new Headers(input instanceof Request ? input.headers : init?.headers);
  headers.set("ngrok-skip-browser-warning", "1");
  if (isCapabilityTicket) {
    // Capability tickets use token in URL and skip basic auth
  } else {
    headers.set("authorization", __LOCAL_SYSTEM_REMOTE_AUTHORIZATION);
  }
  if (input instanceof Request) {
    return __localSystemNativeFetch(new Request(url.toString(), input), { ...init, headers });
  }
  return __localSystemNativeFetch(url.toString(), { ...init, headers });
};`;
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) continue;
    const [rawKey, inlineValue] = arg.slice(2).split("=", 2);
    const value = inlineValue ?? argv[index + 1];
    if (inlineValue == null) index += 1;
    parsed[rawKey] = value;
  }
  return parsed;
}

function normalizeOrigin(value) {
  if (!value) throw new Error("Safari bridge origin is required (--origin or SAFARI_BRIDGE_ORIGIN)");
  const url = new URL(String(value));
  if (url.protocol !== "https:") throw new Error("Safari bridge origin must use https");
  if (url.pathname !== "/" || url.search || url.hash) throw new Error("Safari bridge origin must not include a path, query, or hash");
  return url.origin;
}

function readPassword(parsed) {
  if (parsed["password-file"]) {
    return fs.readFileSync(path.resolve(parsed["password-file"]), "utf8").trim();
  }
  const value = parsed.password || process.env.SAFARI_BRIDGE_PASSWORD;
  if (!value) throw new Error("Safari bridge password is required (--password-file or SAFARI_BRIDGE_PASSWORD)");
  return String(value);
}
