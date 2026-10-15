import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import process from "node:process";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8767;
const DEFAULT_LOCAL_SYSTEM_PORT = 8765;
const DEFAULT_FALLBACK_PORT = 8082;
const LOCAL_SYSTEM_PREFIXES = ["/local-ui/", "/local-image/", "/local-file/"];
const SAFARI_EXTENSION_ORIGIN = /^safari-web-extension:\/\/[A-Za-z0-9.-]+$/;
const CAPABILITY_TICKET_PATH = /^\/local-(?:file|image)\/[A-Za-z0-9_-]{20,}$/;
const ALLOWED_CORS_HEADERS = "authorization, content-type, ngrok-skip-browser-warning, x-local-system-session, x-local-system-image";

const args = parseArgs(process.argv.slice(2));
const host = String(args.host || process.env.SAFARI_ROUTER_HOST || DEFAULT_HOST);
const port = normalizePort(args.port || process.env.SAFARI_ROUTER_PORT, DEFAULT_PORT);
const localSystemPort = normalizePort(args["local-system-port"] || process.env.SAFARI_LOCAL_SYSTEM_PORT, DEFAULT_LOCAL_SYSTEM_PORT);
const fallbackPort = normalizePort(args["fallback-port"] || process.env.SAFARI_FALLBACK_PORT, DEFAULT_FALLBACK_PORT);
const username = String(args.username || process.env.SAFARI_BRIDGE_USERNAME || "local-system");
const password = readPassword(args);
const expectedAuthorization = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;

const server = http.createServer((req, res) => {
  if (isLocalSystemPath(req.url)) {
    if (req.method === "OPTIONS") {
      return respondToSafariPreflight(req, res);
    }
    if (!isCapabilityTicketRequest(req) && !authorizationMatches(req.headers.authorization, expectedAuthorization)) {
      res.writeHead(401, {
        "cache-control": "no-store",
        "content-type": "application/json",
        "www-authenticate": 'Basic realm="local-system-mobile"',
      });
      res.end(JSON.stringify({ error: "authentication required" }));
      return;
    }
    proxyHttp(req, res, { port: localSystemPort, localSystem: true });
    return;
  }
  proxyHttp(req, res, { port: fallbackPort, localSystem: false });
});

server.on("upgrade", (req, clientSocket, head) => {
  if (isLocalSystemPath(req.url)) {
    clientSocket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    return;
  }
  proxyUpgrade(req, clientSocket, head, fallbackPort);
});

server.listen(port, host, () => {
  console.log(`[safari-mobile-router] http://${host}:${port}`);
  console.log(`[safari-mobile-router] Local System paths -> http://127.0.0.1:${localSystemPort}`);
  console.log(`[safari-mobile-router] all other traffic -> http://127.0.0.1:${fallbackPort}`);
});

function proxyHttp(req, res, { port: upstreamPort, localSystem }) {
  const headers = { ...req.headers };
  if (localSystem) {
    headers.host = "localhost";
    delete headers.authorization;
  }
  const upstream = http.request({
    hostname: "127.0.0.1",
    port: upstreamPort,
    method: req.method,
    path: req.url,
    headers,
  }, (upstreamRes) => {
    const responseHeaders = { ...upstreamRes.headers };
    if (localSystem) applySafariCors(req, responseHeaders);
    res.writeHead(upstreamRes.statusCode || 502, responseHeaders);
    upstreamRes.pipe(res);
  });
  upstream.on("error", (error) => {
    if (res.headersSent) {
      res.destroy(error);
      return;
    }
    res.writeHead(502, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
    res.end(`Safari mobile router upstream error: ${error.message}`);
  });
  req.pipe(upstream);
}

function respondToSafariPreflight(req, res) {
  const origin = String(req.headers.origin || "");
  if (!isAllowedSafariExtensionOrigin(origin)) {
    res.writeHead(403, { "cache-control": "no-store", "content-type": "text/plain; charset=utf-8" });
    res.end("Forbidden");
    return;
  }
  res.writeHead(204, {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": ALLOWED_CORS_HEADERS,
    "access-control-max-age": "600",
    "cache-control": "no-store",
    "vary": "Origin",
  });
  res.end();
}

function applySafariCors(req, headers) {
  const origin = String(req.headers.origin || "");
  if (!isAllowedSafariExtensionOrigin(origin)) return;
  headers["access-control-allow-origin"] = origin;
  headers.vary = mergeVary(headers.vary, "Origin");
}

export function isAllowedSafariExtensionOrigin(value) {
  return SAFARI_EXTENSION_ORIGIN.test(String(value || ""));
}

export function isCapabilityTicketRequest(req) {
  if (String(req?.method || "").toUpperCase() !== "GET") return false;
  let pathname;
  try {
    pathname = new URL(String(req?.url || "/"), "http://localhost").pathname;
  } catch {
    return false;
  }
  return CAPABILITY_TICKET_PATH.test(pathname);
}

function mergeVary(value, token) {
  const parts = String(value || "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (!parts.some((part) => part.toLowerCase() === token.toLowerCase())) parts.push(token);
  return parts.join(", ");
}

function proxyUpgrade(req, clientSocket, head, upstreamPort) {
  const upstreamSocket = net.connect(upstreamPort, "127.0.0.1", () => {
    const headers = Object.entries(req.headers)
      .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(", ") : value}`)
      .join("\r\n");
    upstreamSocket.write(`${req.method} ${req.url} HTTP/${req.httpVersion}\r\n${headers}\r\n\r\n`);
    if (head?.length) upstreamSocket.write(head);
    clientSocket.pipe(upstreamSocket).pipe(clientSocket);
  });
  upstreamSocket.on("error", () => clientSocket.destroy());
  clientSocket.on("error", () => upstreamSocket.destroy());
}

export function isLocalSystemPath(value) {
  let pathname;
  try {
    pathname = new URL(String(value || "/"), "http://localhost").pathname;
  } catch {
    return false;
  }
  return LOCAL_SYSTEM_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

function authorizationMatches(actual, expected) {
  if (typeof actual !== "string") return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function readPassword(parsed) {
  if (parsed["password-file"]) {
    return fs.readFileSync(path.resolve(parsed["password-file"]), "utf8").trim();
  }
  const value = parsed.password || process.env.SAFARI_BRIDGE_PASSWORD;
  if (!value) throw new Error("Safari bridge password is required (--password-file or SAFARI_BRIDGE_PASSWORD)");
  return String(value);
}

function normalizePort(value, fallback) {
  if (value == null || value === "") return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > 65535) throw new Error(`invalid port: ${value}`);
  return number;
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
