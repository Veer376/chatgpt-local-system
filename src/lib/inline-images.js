import fs from "node:fs";
import { detectModelImageMimeType } from "../tools/files.js";
import { assertInWorkspace, resolveUserPath } from "./paths.js";

// A command that produces an image says so by printing this on its own line.
// The convention belongs to the script that emits it, not to the model: the
// model runs an ordinary command and the picture arrives with the result.
const MARKER = /^@@image[ \t]+(.+?)[ \t]*$/gm;
const MAX_IMAGES = 3;
const MAX_BYTES = 10 * 1024 * 1024;

// Returns the image blocks to append to a tool result, the output with the
// markers removed, and one note per marker that could not be honored.
export function extractInlineImages(stdout) {
  const text = String(stdout || "");
  const paths = [...text.matchAll(MARKER)].map((match) => match[1].trim()).filter(Boolean);
  if (paths.length === 0) return { images: [], text, attached: [], skipped: [] };

  const images = [];
  const attached = [];
  const skipped = [];
  for (const candidate of paths) {
    if (images.length >= MAX_IMAGES) {
      skipped.push({ path: candidate, reason: `only ${MAX_IMAGES} images are attached per result` });
      continue;
    }
    try {
      // Same boundary as every other read: an image outside the authorized
      // roots is named in the output but never inlined.
      const resolved = assertInWorkspace(resolveUserPath(candidate));
      const stat = fs.statSync(resolved);
      if (!stat.isFile()) throw new Error("not a file");
      if (stat.size > MAX_BYTES) throw new Error(`image is ${stat.size} bytes; maximum ${MAX_BYTES}`);
      const data = fs.readFileSync(resolved);
      const mimeType = detectModelImageMimeType(data);
      if (!mimeType) throw new Error("not a PNG, JPEG, GIF, or WebP image");
      images.push({ type: "image", data: data.toString("base64"), mimeType });
      attached.push(resolved);
    } catch (error) {
      skipped.push({ path: candidate, reason: error.message });
    }
  }
  return { images, text: text.replace(MARKER, "").replace(/\n{3,}/g, "\n\n"), attached, skipped };
}

// Appends the images to a tool result and records what happened in the
// structured payload, so a skipped image is visible rather than silently gone.
// Both streams are scanned: a program whose stdout is structured output has
// nowhere but stderr to announce an image.
export function withInlineImages(result, data = {}) {
  const found = extractInlineImages(`${data.stdout || ""}\n${data.stderr || ""}`);
  if (found.images.length === 0 && found.skipped.length === 0) return result;
  result.content.push(...found.images);
  if (result.structuredContent) {
    if (data.stdout) result.structuredContent.stdout = stripMarkers(data.stdout);
    if (data.stderr) result.structuredContent.stderr = stripMarkers(data.stderr);
    if (found.attached.length) result.structuredContent.images = found.attached;
    if (found.skipped.length) result.structuredContent.imagesSkipped = found.skipped;
  }
  return result;
}

function stripMarkers(text) {
  return String(text).replace(MARKER, "").replace(/\n{3,}/g, "\n\n");
}
