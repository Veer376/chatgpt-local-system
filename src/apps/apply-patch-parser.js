function decodeGitQuotedPath(value) {
  const text = String(value || "");
  if (!(text.startsWith('"') && text.endsWith('"'))) return text;
  const body = text.slice(1, -1);
  const bytes = [];
  const encoder = new TextEncoder();

  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (char !== "\\") {
      const codePoint = body.codePointAt(index);
      const literal = codePoint != null && codePoint > 0xffff ? body.slice(index, index + 2) : char;
      bytes.push(...encoder.encode(literal));
      if (literal.length === 2) index += 1;
      continue;
    }

    const next = body[index + 1];
    if (next == null) {
      bytes.push(0x5c);
      continue;
    }
    const octal = body.slice(index + 1).match(/^[0-7]{1,3}/)?.[0];
    if (octal) {
      bytes.push(Number.parseInt(octal, 8));
      index += octal.length;
      continue;
    }
    const escapes = { a: 0x07, b: 0x08, t: 0x09, n: 0x0a, v: 0x0b, f: 0x0c, r: 0x0d };
    if (Object.hasOwn(escapes, next)) bytes.push(escapes[next]);
    else bytes.push(...encoder.encode(next));
    index += 1;
  }

  return new TextDecoder().decode(Uint8Array.from(bytes));
}

function pathToken(value) {
  const text = String(value || "").trimStart();
  if (!text.startsWith('"')) return text.split("\t", 1)[0].trim();
  let escaped = false;
  for (let index = 1; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"' && !escaped) return text.slice(0, index + 1);
    if (char === "\\" && !escaped) escaped = true;
    else escaped = false;
  }
  return text;
}

function normalizePath(value) {
  const text = decodeGitQuotedPath(pathToken(value));
  if (!text || text === "/dev/null" || /^NUL$/i.test(text)) return "";
  return text.replace(/^[ab]\//, "");
}

function gitHeaderPath(value) {
  const body = String(value || "").replace(/^diff --git\s+/, "");
  if (!body) return "";
  if (body.startsWith('"')) {
    const first = pathToken(body);
    const rest = body.slice(first.length).trimStart();
    return normalizePath(pathToken(rest));
  }
  const separator = body.lastIndexOf(" b/");
  return separator >= 0 ? normalizePath(body.slice(separator + 1)) : "";
}

function basename(filePath) {
  const parts = String(filePath || "").split("/");
  return parts.at(-1) || filePath || "file";
}

export function parseHunkRange(line) {
  const match = String(line || "").match(/^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/);
  if (!match) return null;
  return {
    oldRemaining: match[2] == null ? 1 : Number(match[2]),
    newRemaining: match[4] == null ? 1 : Number(match[4]),
  };
}

export function consumeHunkLine(hunk, line) {
  if (!hunk || line.startsWith("\\ No newline")) return hunk;
  if (line.startsWith("+")) hunk.newRemaining -= 1;
  else if (line.startsWith("-")) hunk.oldRemaining -= 1;
  else if (line.startsWith(" ")) {
    hunk.oldRemaining -= 1;
    hunk.newRemaining -= 1;
  }
  return hunk.oldRemaining <= 0 && hunk.newRemaining <= 0 ? null : hunk;
}

export function classifyUnifiedLines(lines) {
  let activeHunk = null;
  return lines.map((line) => {
    let kind;
    if (line.startsWith("@@")) {
      activeHunk = parseHunkRange(line);
      return { line, kind: "hunk" };
    }
    if (activeHunk) {
      if (line.startsWith("\\ No newline")) kind = "meta";
      else if (line.startsWith("+")) kind = "added";
      else if (line.startsWith("-")) kind = "removed";
      else kind = "context";
      activeHunk = consumeHunkLine(activeHunk, line);
      return { line, kind };
    }
    if (line.startsWith("--- ") || line.startsWith("+++ ")) kind = "file-header";
    else if (line.startsWith("\\ No newline")) kind = "meta";
    else kind = "context";
    return { line, kind };
  });
}

function isHeaderPair(lines, index) {
  return lines[index]?.startsWith("--- ") && lines[index + 1]?.startsWith("+++ ");
}

export function splitUnifiedDiff(diff) {
  const lines = String(diff || "").replace(/\r\n/g, "\n").split("\n");
  const files = [];
  let current = [];
  let hasFileHeaders = false;
  let activeHunk = null;

  const flush = () => {
    if (!current.length) return;
    const file = parseFileChunk(current);
    if (file) files.push(file);
    current = [];
    hasFileHeaders = false;
    activeHunk = null;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];

    if (line.startsWith("diff --git ") || line.startsWith("Index: ")) {
      flush();
      current.push(line);
      continue;
    }

    if (!activeHunk && isHeaderPair(lines, index)) {
      if (hasFileHeaders) flush();
      current.push(line, lines[index + 1]);
      hasFileHeaders = true;
      index += 1;
      continue;
    }

    if (!current.length) continue;
    current.push(line);

    if (line.startsWith("@@")) activeHunk = parseHunkRange(line);
    else activeHunk = consumeHunkLine(activeHunk, line);
  }

  flush();
  return files;
}

function parseFileChunk(lines) {
  const oldHeader = lines.find((line) => line.startsWith("--- ")) || "";
  const newHeader = lines.find((line) => line.startsWith("+++ ")) || "";
  const indexHeader = lines.find((line) => line.startsWith("Index: ")) || "";
  const gitHeader = lines.find((line) => line.startsWith("diff --git ")) || "";
  const oldPath = normalizePath(oldHeader.slice(4));
  const newPath = normalizePath(newHeader.slice(4));
  const indexedPath = normalizePath(indexHeader.slice(7));
  const filePath = newPath || oldPath || indexedPath || gitHeaderPath(gitHeader);
  if (!filePath) return null;

  let additions = 0;
  let deletions = 0;
  for (const { kind } of classifyUnifiedLines(lines)) {
    if (kind === "added") additions += 1;
    else if (kind === "removed") deletions += 1;
  }

  return {
    path: filePath,
    name: basename(filePath),
    additions,
    deletions,
    language: languageForPath(filePath),
    lines: lines.filter((line) => {
      if (line.startsWith("diff --git ") || line.startsWith("Index: ")) return false;
      if (/^={20,}$/.test(line)) return false;
      if (/^(new|deleted) file mode\b/.test(line)) return false;
      return line !== "";
    }),
  };
}

function languageForPath(filePath) {
  const ext = String(filePath || "").toLowerCase().match(/\.([^.\\/]+)$/)?.[1] || "";
  return ({
    js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
    ts: "typescript", tsx: "typescript",
    py: "python",
    json: "json", jsonc: "json",
    css: "css", scss: "css",
    html: "xml", htm: "xml", xml: "xml", svg: "xml",
    md: "markdown", markdown: "markdown",
    sh: "bash", bash: "bash", zsh: "bash",
    yml: "yaml", yaml: "yaml",
  })[ext] || null;
}
