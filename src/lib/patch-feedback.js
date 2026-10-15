import fs from "node:fs";
import path from "node:path";
import { splitUnifiedDiff } from "../apps/apply-patch-parser.js";
import { isWithin } from "./paths.js";

// `git apply` reports that a patch did not apply, but not what the file
// actually contains. Without that the agent must spend a round trip reading the
// file before it can correct the patch. These helpers attach the real content
// at each failed hunk so a retry can be built from the same response.

const MAX_FILES = 5;
const MAX_HUNKS_PER_FILE = 5;
const CONTEXT_LINES = 8;
const MAX_LINE_CHARS = 200;

function clipLine(line) {
  const text = String(line ?? "");
  return text.length <= MAX_LINE_CHARS ? text : `${text.slice(0, MAX_LINE_CHARS)}…`;
}

function hunkStarts(fileLines) {
  const starts = [];
  for (const line of fileLines || []) {
    const match = String(line).match(/^@@\s+-(\d+)/);
    if (match) starts.push(Number(match[1]));
  }
  return starts;
}

export function patchFailureContext(diff, root, {
  contextLines = CONTEXT_LINES,
  maxFiles = MAX_FILES,
  maxHunks = MAX_HUNKS_PER_FILE,
} = {}) {
  let parsed;
  try {
    parsed = splitUnifiedDiff(diff);
  } catch {
    return [];
  }

  const results = [];
  for (const file of parsed.slice(0, maxFiles)) {
    const entry = { path: file.path, exists: false, hunks: [] };

    let absolute;
    try {
      absolute = path.resolve(root, file.path);
    } catch {
      results.push(entry);
      continue;
    }
    // A patch may name any path; never read outside the workspace to describe it.
    if (!isWithin(absolute, root)) {
      results.push({ ...entry, outsideWorkspace: true });
      continue;
    }

    let lines = null;
    try {
      if (fs.statSync(absolute).isFile()) {
        lines = fs.readFileSync(absolute, "utf8").replace(/\r\n/g, "\n").split("\n");
        entry.exists = true;
        entry.lineCount = lines.length;
      }
    } catch { /* treated as missing */ }

    for (const start of hunkStarts(file.lines).slice(0, maxHunks)) {
      const hunk = { expectedStart: start };
      if (lines) {
        const from = Math.max(1, start - contextLines);
        const to = Math.min(lines.length, start + contextLines);
        hunk.actual = [];
        for (let number = from; number <= to; number += 1) {
          hunk.actual.push(`${number}: ${clipLine(lines[number - 1])}`);
        }
        if (start > lines.length) hunk.beyondEndOfFile = true;
      }
      entry.hunks.push(hunk);
    }
    results.push(entry);
  }
  return results;
}

// git rejects a malformed patch before it ever compares it to a file. Showing
// file content for those reads as a context mismatch and sends the agent to
// rewrite context that was already correct, so the two cases must be told apart.
const MALFORMED_PATCH = /corrupt patch|unrecognized input|patch fragment without header|patch with only garbage|does not match index/i;

export function isMalformedPatchError(error) {
  return MALFORMED_PATCH.test(String(error || ""));
}

export function renderPatchFailure(error, context) {
  const sections = [String(error || "git apply failed")];

  if (isMalformedPatchError(error)) {
    sections.push(
      "\nThe patch text is malformed, so no file was compared — the context lines may be correct."
      + " Check that each @@ header's line counts match the hunk body.",
    );
    const named = context.map((file) => file.path).filter(Boolean);
    if (named.length) sections.push(`Targeted: ${named.join(", ")}`);
    return sections.join("\n");
  }

  for (const file of context) {
    if (file.outsideWorkspace) {
      sections.push(`\n${file.path}: outside the workspace; not read.`);
      continue;
    }
    if (!file.exists) {
      sections.push(`\n${file.path}: does not exist. Use an add-file patch, or correct the path.`);
      continue;
    }
    for (const hunk of file.hunks) {
      const header = hunk.beyondEndOfFile
        ? `\n${file.path} has ${file.lineCount} lines; the hunk targets line ${hunk.expectedStart}, past the end.`
        : `\n${file.path} around line ${hunk.expectedStart} actually contains:`;
      sections.push(header);
      if (hunk.actual?.length) sections.push(hunk.actual.join("\n"));
    }
    if (!file.hunks.length) sections.push(`\n${file.path}: no hunk headers found in the patch.`);
  }
  return sections.join("\n");
}
