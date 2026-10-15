import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  FILE_PREVIEW_AWS_BIN,
  FILE_PREVIEW_AWS_PROFILE,
  FILE_PREVIEW_AWS_REGION,
  FILE_PREVIEW_CLOUD_CATEGORIES,
  FILE_PREVIEW_CLOUD_ENABLED,
  FILE_PREVIEW_CLOUD_TIMEOUT_MS,
  FILE_PREVIEW_PRESIGN_SECONDS,
  FILE_PREVIEW_S3_BUCKET,
} from "./config.js";
import { runCommand } from "./exec.js";

const CLOUD_PREFIX = "previews/v1";

export function cloudPreviewEnabledFor(category) {
  return FILE_PREVIEW_CLOUD_ENABLED
    && FILE_PREVIEW_CLOUD_CATEGORIES.has(String(category || "").toLowerCase());
}

export function cloudPreviewOrigin() {
  if (!FILE_PREVIEW_CLOUD_ENABLED || !FILE_PREVIEW_S3_BUCKET || !FILE_PREVIEW_AWS_REGION) return "";
  return `https://${FILE_PREVIEW_S3_BUCKET}.s3.${FILE_PREVIEW_AWS_REGION}.amazonaws.com`;
}

export async function createS3Preview(filePath, { category, mimeType } = {}) {
  if (!cloudPreviewEnabledFor(category)) return null;
  requireCloudConfig();

  const stat = fs.statSync(filePath);
  if (!stat.isFile()) throw new Error("cloud preview source is not a file");

  const digest = await sha256File(filePath);
  const afterHash = fs.statSync(filePath);
  if (afterHash.size !== stat.size || afterHash.mtimeMs !== stat.mtimeMs) {
    throw new Error("cloud preview source changed while it was being hashed");
  }

  const safeName = sanitizeObjectName(path.basename(filePath));
  const fingerprint = `${digest}-${stat.size}-${Math.trunc(stat.mtimeMs)}`;
  const key = `${CLOUD_PREFIX}/${digest.slice(0, 2)}/${fingerprint}/${safeName}`;
  const common = awsScopeArgs();

  const head = await runAws([
    "s3api", "head-object",
    "--bucket", FILE_PREVIEW_S3_BUCKET,
    "--key", key,
    ...common,
  ], { timeoutMs: 30_000 });

  if (!head.ok) {
    const upload = await runAws([
      "s3", "cp",
      filePath,
      `s3://${FILE_PREVIEW_S3_BUCKET}/${key}`,
      "--only-show-errors",
      "--no-progress",
      "--content-type", mimeType || "application/octet-stream",
      "--cache-control", "private, max-age=3600",
      ...common,
    ]);
    if (!upload.ok) throw awsError("upload", upload);
  }

  const afterUpload = fs.statSync(filePath);
  if (afterUpload.size !== stat.size || afterUpload.mtimeMs !== stat.mtimeMs) {
    throw new Error("cloud preview source changed while it was being uploaded");
  }

  const presigned = await runAws([
    "s3", "presign",
    `s3://${FILE_PREVIEW_S3_BUCKET}/${key}`,
    "--expires-in", String(FILE_PREVIEW_PRESIGN_SECONDS),
    ...common,
  ], { timeoutMs: 30_000 });
  if (!presigned.ok) throw awsError("presign", presigned);

  const url = validatePresignedUrl(String(presigned.stdout || "").trim());
  return {
    provider: "s3",
    url,
    key,
    sha256: digest,
    expiresAt: Date.now() + (FILE_PREVIEW_PRESIGN_SECONDS * 1_000),
  };
}

function requireCloudConfig() {
  const missing = [];
  if (!FILE_PREVIEW_S3_BUCKET) missing.push("FILE_PREVIEW_S3_BUCKET");
  if (!FILE_PREVIEW_AWS_REGION) missing.push("FILE_PREVIEW_AWS_REGION");
  if (!FILE_PREVIEW_AWS_BIN) missing.push("FILE_PREVIEW_AWS_BIN");
  if (missing.length) throw new Error(`cloud preview configuration is incomplete: ${missing.join(", ")}`);
}

function awsScopeArgs() {
  const args = ["--region", FILE_PREVIEW_AWS_REGION];
  if (FILE_PREVIEW_AWS_PROFILE) args.push("--profile", FILE_PREVIEW_AWS_PROFILE);
  return args;
}

async function runAws(args, { timeoutMs = FILE_PREVIEW_CLOUD_TIMEOUT_MS } = {}) {
  return runCommand([FILE_PREVIEW_AWS_BIN, ...args], {
    shell: false,
    timeoutMs,
    maxStdout: 16_000,
    maxStderr: 16_000,
  });
}

function awsError(action, result) {
  const detail = String(result?.stderr || result?.stdout || "").trim();
  const suffix = detail ? `: ${detail.slice(0, 800)}` : "";
  return new Error(`S3 preview ${action} failed${suffix}`);
}

function validatePresignedUrl(raw) {
  let parsed;
  try { parsed = new URL(raw); }
  catch { throw new Error("S3 preview presign returned an invalid URL"); }
  if (parsed.protocol !== "https:") throw new Error("S3 preview URL must use HTTPS");
  const expected = new URL(cloudPreviewOrigin());
  if (parsed.hostname !== expected.hostname) {
    throw new Error(`S3 preview URL host mismatch: expected ${expected.hostname}, received ${parsed.hostname}`);
  }
  return parsed.href;
}

export function sanitizeObjectName(name) {
  const cleaned = String(name || "file")
    .normalize("NFKC")
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^[_.]+|[_.]+$/g, "") || "file";
  if (cleaned.length <= 120) return cleaned;
  const ext = path.extname(cleaned).slice(0, 16);
  const stem = path.basename(cleaned, ext).slice(0, Math.max(1, 120 - ext.length));
  return `${stem}${ext}`;
}

async function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}
