import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { registerAppResource, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { MAX_SKILL_NAMES, SKILL_ROOTS } from "../lib/config.js";
import { currentProjectWorkspace, isWithin } from "../lib/paths.js";
import { structured } from "../lib/text.js";
import { registerOptionalAppTool } from "../lib/tool-ui.js";

const PAGE_SIZE = 10;
// A prefix only counts as a match once the shorter token is a plausible stem.
const MIN_PREFIX_TOKEN_LENGTH = 3;
// Results scoring below this share of the best match are noise, not answers.
const RELEVANCE_RATIO = 0.25;
const CURSOR_VERSION = 1;
const here = path.dirname(fileURLToPath(import.meta.url));
const SKILLS_RESOURCE_URI = "ui://sol/skills-browser.html";
const SKILLS_HTML = fs.readFileSync(path.resolve(here, "../apps/skills-browser.html"), "utf8");

export function registerSkills(server) {
  registerOptionalAppTool(server, "discover_skills", {
    title: "Discover skills",
    description: "List or search skills. Read <path>/SKILL.md, and any references it names, before using one.",
    inputSchema: {
      query: z.string().max(500).optional().describe("Search text."),
      cursor: z.string().max(2_000).optional().describe("Continuation cursor returned by the previous discover_skills call. Reuse it with the same query."),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, SKILLS_RESOURCE_URI, async ({ query, cursor }) => {
    const result = discoverSkills({
      roots: SKILL_ROOTS,
      projectWorkspace: currentProjectWorkspace(),
      query,
      cursor,
    });
    return structured(`Found ${result.skills.length} of ${result.total} skills.`, result);
  });

  registerAppResource(server, "Skills Browser", SKILLS_RESOURCE_URI, { mimeType: RESOURCE_MIME_TYPE }, async () => ({
    contents: [{ uri: SKILLS_RESOURCE_URI, mimeType: RESOURCE_MIME_TYPE, text: SKILLS_HTML }],
  }));
}

// A name-only index of every available skill, grouped by scope. `discoverSkills`
// paginates with a fixed page size, so it cannot enumerate large skill sets in one call; this
// exists to give an agent the full picture cheaply. Descriptions are omitted on
// purpose: names are the index, `discover_skills` is the lookup.
export function skillNameIndex({
  roots = SKILL_ROOTS,
  projectWorkspace = "",
  cap = MAX_SKILL_NAMES,
} = {}) {
  const collected = [];
  const sources = skillSources({ roots, projectWorkspace });
  for (const source of sources) {
    collectSkillDirs(source.root, source.root, collected, 0, source.scope);
  }
  collected.sort(compareSkills);

  const namesFor = (scope) => [...new Set(collected.filter((s) => s.scope === scope).map((s) => s.name))];
  const personalAll = namesFor("personal");
  const projectAll = namesFor("project");
  const hasProjectSource = sources.some((source) => source.scope === "project");

  return {
    personal: personalAll.slice(0, cap),
    // null means "not knowable yet" (no workspace selected); [] means "workspace
    // selected, but it has no skills of its own".
    project: hasProjectSource ? projectAll.slice(0, cap) : (projectWorkspace ? [] : null),
    truncated: personalAll.length > cap || projectAll.length > cap,
    total: personalAll.length + projectAll.length,
  };
}

export function discoverSkills({
  roots = SKILL_ROOTS,
  projectWorkspace = "",
  query = "",
  cursor,
} = {}) {
  const allSkills = [];
  const sources = skillSources({ roots, projectWorkspace });
  for (const source of sources) {
    collectSkillDirs(source.root, source.root, allSkills, 0, source.scope);
  }

  const normalizedQuery = normalizeText(query);
  const ranked = normalizedQuery
    ? rankSkills(allSkills, normalizedQuery)
    : allSkills.sort(compareSkills);

  const start = decodeCursor(cursor, normalizedQuery);
  const skills = ranked.slice(start, start + PAGE_SIZE);
  const nextOffset = start + skills.length;
  const nextCursor = nextOffset < ranked.length
    ? encodeCursor({ offset: nextOffset, query: normalizedQuery })
    : null;

  return {
    query,
    total: ranked.length,
    ...(nextCursor ? { nextCursor } : {}),
    roots: sources.map((source) => source.root),
    skills,
  };
}

function encodeCursor({ offset, query }) {
  return Buffer.from(JSON.stringify({ v: CURSOR_VERSION, o: offset, q: query }), "utf8").toString("base64url");
}

function decodeCursor(cursor, normalizedQuery) {
  if (!cursor) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (parsed?.v !== CURSOR_VERSION || !Number.isInteger(parsed?.o) || parsed.o < 0 || parsed.q !== normalizedQuery) {
      throw new Error("invalid cursor");
    }
    return parsed.o;
  } catch {
    throw new Error("invalid discover_skills cursor; start a new pagination loop without cursor");
  }
}

function skillSources({ roots, projectWorkspace }) {
  const sources = [];
  const seen = new Set();
  const projectRoot = resolveProjectSkillRoot(projectWorkspace);
  if (projectRoot) addSource(projectRoot, "project");
  for (const root of roots) addSource(root, "personal");
  return sources;

  function addSource(root, scope) {
    if (!isDirectory(root)) return;
    const canonical = fs.realpathSync.native(root);
    if (seen.has(canonical)) return;
    seen.add(canonical);
    sources.push({ root: canonical, scope });
  }
}

function resolveProjectSkillRoot(projectWorkspace) {
  if (!projectWorkspace || !isDirectory(projectWorkspace)) return "";
  const project = fs.realpathSync.native(projectWorkspace);
  const candidate = path.join(project, ".agents", "skills");
  if (!isDirectory(candidate)) return "";
  const canonical = fs.realpathSync.native(candidate);
  return isWithin(canonical, project) ? canonical : "";
}

function compareSkills(a, b) {
  return a.name.localeCompare(b.name)
    || scopeRank(a.scope) - scopeRank(b.scope)
    || a.path.localeCompare(b.path);
}

function scopeRank(scope) {
  return scope === "project" ? 0 : 1;
}

// Scoring alone decides the order; this decides who is worth returning at all.
// Every skill in a library about the local system mentions "local" somewhere, so
// an unfiltered search for `local-system` hands back most of the shelf and the
// agent pays to read it.
function rankSkills(skills, normalizedQuery) {
  const queryTokens = tokenize(normalizedQuery);
  const scored = skills
    .map((skill) => ({ skill, ...scoreSkill(skill, normalizedQuery, queryTokens) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || compareSkills(a.skill, b.skill));

  // Prefer the skills that account for every word of the query. Falling back to
  // partial matches only when nothing matches in full lets a typo or a stray
  // word narrow the result instead of emptying it.
  const complete = scored.filter((entry) => entry.matchedAll);
  const candidates = complete.length ? complete : scored;
  if (!candidates.length) return [];

  // One incidental word in a description scores an order of magnitude below a
  // real hit. Cutting relative to the best match drops that tail without
  // hard-coding what counts as relevant for a library we do not control.
  const floor = candidates[0].score * RELEVANCE_RATIO;
  return candidates.filter((entry) => entry.score >= floor).map((entry) => entry.skill);
}

function scoreSkill(skill, normalizedQuery, queryTokens) {
  const normalizedName = normalizeText(skill.name);
  const normalizedDescription = normalizeText(skill.description);
  const nameTokens = tokenize(normalizedName);
  const descriptionTokens = tokenize(normalizedDescription);

  if (normalizedName === normalizedQuery) return { score: 1000, matchedAll: true };

  let score = 0;
  if (normalizedName.startsWith(normalizedQuery)) score += 500;
  if (normalizedName.includes(normalizedQuery)) score += 350;

  const allNameTokensMatched = queryTokens.length > 0 && queryTokens.every((token) => nameTokens.some((candidate) => tokenMatches(token, candidate)));
  if (allNameTokensMatched) score += 250;

  // The whole query appearing verbatim in a description is real evidence, and
  // scoring it token by token undervalues it enough to fall under the cut.
  if (queryTokens.length > 1 && normalizedDescription.includes(normalizedQuery)) score += 120;

  let matchedTokens = 0;
  for (const token of queryTokens) {
    let matched = false;

    if (nameTokens.includes(token)) { score += 80; matched = true; }
    else if (nameTokens.some((candidate) => tokenMatches(token, candidate))) { score += 45; matched = true; }

    if (descriptionTokens.includes(token)) { score += 25; matched = true; }
    else if (descriptionTokens.some((candidate) => tokenMatches(token, candidate))) { score += 10; matched = true; }

    if (matched) matchedTokens += 1;
  }

  return { score, matchedAll: queryTokens.length > 0 && matchedTokens === queryTokens.length };
}

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/^\/+/, "")
    .replace(/[/_.-]+/g, " ")
    .replace(/[^a-z0-9\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(value) {
  return normalizeText(value).split(" ").filter(Boolean);
}

function tokenMatches(queryToken, candidateToken) {
  if (!queryToken || !candidateToken) return false;
  if (queryToken === candidateToken) return true;
  // Without a length floor a bare "s" in any description is a prefix of "system"
  // and the whole library matches.
  const prefixable = Math.min(queryToken.length, candidateToken.length) >= MIN_PREFIX_TOKEN_LENGTH;
  if (prefixable && (candidateToken.startsWith(queryToken) || queryToken.startsWith(candidateToken))) return true;
  return levenshtein(queryToken, candidateToken) <= allowedDistance(queryToken, candidateToken);
}

function allowedDistance(a, b) {
  const longest = Math.max(a.length, b.length);
  if (longest < 5) return 0;
  if (longest < 9) return 1;
  return 2;
}

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  const current = new Array(b.length + 1);

  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const substitutionCost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + substitutionCost,
      );
    }
    for (let j = 0; j <= b.length; j += 1) previous[j] = current[j];
  }

  return previous[b.length];
}

function collectSkillDirs(root, dir, skills, depth, scope) {
  if (depth > 2) return;
  const skillFile = path.join(dir, "SKILL.md");
  if (fs.existsSync(skillFile) && fs.statSync(skillFile).isFile()) {
    const metadata = readFrontmatter(skillFile);
    skills.push({
      name: metadata.name || path.basename(dir),
      description: metadata.description || "",
      scope,
      // The directory is the one path worth spending context on: SKILL.md and
      // any scripts or references it names are all relative to it.
      path: dir,
    });
    return;
  }

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    if (entry.name.startsWith(".") || ["node_modules", "__pycache__"].includes(entry.name)) continue;
    collectSkillDirs(root, path.join(dir, entry.name), skills, depth + 1, scope);
  }
}

function readFrontmatter(skillFile) {
  const text = fs.readFileSync(skillFile, "utf8").slice(0, 32_000);
  if (!text.startsWith("---")) return {};
  const end = text.indexOf("\n---", 3);
  if (end === -1) return {};
  const block = text.slice(3, end).trim();
  const metadata = {};
  const lines = block.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) continue;
    const [, key, raw] = match;
    if (key !== "name" && key !== "description") continue;
    const value = raw.trim();
    // `description: >` and `description: |` put the text on the indented lines
    // that follow. Reading only the marker leaves the skill describing itself
    // as ">" and effectively unsearchable.
    metadata[key] = /^[>|][+-]?\d*$/.test(value)
      ? readBlockScalar(lines, index + 1, value.startsWith("|"))
      : unquote(value);
  }
  return metadata;
}

function readBlockScalar(lines, start, literal) {
  const collected = [];
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() && !/^\s/.test(line)) break;
    collected.push(line.trim());
  }
  while (collected.length && !collected[collected.length - 1]) collected.pop();
  // Folded (>) joins the lines into one paragraph; literal (|) keeps the breaks.
  return literal ? collected.join("\n") : collected.join(" ").replace(/\s+/g, " ").trim();
}

function unquote(value) {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function isDirectory(target) {
  try { return fs.statSync(target).isDirectory(); }
  catch { return false; }
}
