import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  answerBrowserInteraction,
  browserInteractionSnapshot,
  waitForBrowserInteractionChange,
} from "./browser-interaction.js";
import { currentScratchDir } from "./config.js";
import { resolveBrowserThreadState } from "./local-todos.js";

const EXTENSION_HEADER = "x-local-system-extension";
const EXTENSION_HEADER_VALUE = "1";
const MAX_ATTACHMENT_BYTES = 1_250_000;

export function registerLocalInteractionRoutes(app) {
  app.post("/local-ui/interactions", async (req, res) => {
    if (req.get(EXTENSION_HEADER) !== EXTENSION_HEADER_VALUE) {
      return res.status(403).json({ error: "Local System extension header required" });
    }
    try {
      const resolved = resolveBrowserThreadState(req.body?.threadId);
      if (!resolved.bound) {
        return res.set("Cache-Control", "no-store").json({ ok: true, bound: false, revision: 0, interaction: null });
      }
      const action = String(req.body?.action || "get").trim().toLowerCase();
      let snapshot;
      if (action === "upload") {
        const requestId = String(req.body?.requestId || "").trim();
        const current = browserInteractionSnapshot(resolved.conversationKey).interaction;
        if (!current || current.id !== requestId) throw new Error("interaction is no longer pending");
        const attachment = persistInteractionAttachment({
          requestId,
          name: req.body?.name,
          mimeType: req.body?.mimeType,
          data: req.body?.data,
        });
        return res.set("Cache-Control", "no-store").json({ ok: true, bound: true, attachment });
      } else if (action === "respond") {
        answerBrowserInteraction(resolved.conversationKey, {
          requestId: req.body?.requestId,
          answer: req.body?.answer,
          answers: req.body?.answers,
          attachments: req.body?.attachments,
          skip: req.body?.skip === true,
        });
        snapshot = browserInteractionSnapshot(resolved.conversationKey);
      } else if (action === "wait") {
        snapshot = await waitForBrowserInteractionChange(
          resolved.conversationKey,
          req.body?.revision,
          req.body?.timeoutMs,
        );
      } else if (action === "get") {
        snapshot = browserInteractionSnapshot(resolved.conversationKey);
      } else {
        throw new Error("interaction action must be get, wait, upload, or respond");
      }
      return res.set("Cache-Control", "no-store").json({ ok: true, bound: true, ...snapshot });
    } catch (error) {
      return res.status(400).set("Cache-Control", "no-store").json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
}

function persistInteractionAttachment({ requestId, name, mimeType, data }) {
  const normalizedMime = String(mimeType || "application/octet-stream").toLowerCase();
  if (!normalizedMime.startsWith("image/")) throw new Error("only image attachments are supported");
  const encoded = String(data || "").replace(/^data:[^;,]+;base64,/, "");
  if (!encoded) throw new Error("attachment data is required");
  const bytes = Buffer.from(encoded, "base64");
  if (!bytes.length || bytes.length > MAX_ATTACHMENT_BYTES) {
    throw new Error(`image attachment must be ${MAX_ATTACHMENT_BYTES} bytes or smaller after compression`);
  }

  const safeRequestId = String(requestId).replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 80) || "interrupt";
  const fallbackExt = normalizedMime === "image/png" ? ".png" : normalizedMime === "image/webp" ? ".webp" : ".jpg";
  const rawName = path.basename(String(name || `image${fallbackExt}`));
  const safeName = (rawName.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^\.+/, "") || `image${fallbackExt}`).slice(-120);
  const dir = path.join(currentScratchDir(), "interrupts", safeRequestId);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const filePath = path.join(dir, `${Date.now()}-${crypto.randomBytes(4).toString("hex")}-${safeName}`);
  fs.writeFileSync(filePath, bytes, { mode: 0o600 });
  return { path: filePath, name: safeName, mimeType: normalizedMime, bytes: bytes.length };
}
