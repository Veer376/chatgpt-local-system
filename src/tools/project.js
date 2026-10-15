import fs from "node:fs";
import path from "node:path";
import { commandExists } from "../lib/exec.js";

// detectCommand may call commandExists, which spawns a login shell. Cache per
// (root, name) so reporting a verify command cannot slow down a hot path.
const detectCache = new Map();

export function detectCommandCached(root, name) {
  const key = `${root}\u0000${name}`;
  if (!detectCache.has(key)) detectCache.set(key, detectCommand(root, name) || null);
  return detectCache.get(key);
}

export function detectCommand(root, name) {
  const packageCommand = detectPackageCommand(root, name);
  if (packageCommand) return packageCommand;
  if (fs.existsSync(path.join(root, "pyproject.toml")) || fs.existsSync(path.join(root, "pytest.ini")) || fs.existsSync(path.join(root, "requirements.txt"))) {
    const prefix = fs.existsSync(path.join(root, "uv.lock")) && commandExists("uv") ? "uv run " : "";
    const recipes = {
      test: `${prefix}pytest`,
      lint: commandExists("ruff") || prefix ? `${prefix}ruff check .` : null,
      typecheck: commandExists("mypy") || prefix ? `${prefix}mypy .` : commandExists("pyright") ? "pyright" : null,
      build: commandExists("python") ? "python -m build" : "python3 -m build",
      dev: null,
    };
    if (recipes[name]) return recipes[name];
  }
  if (fs.existsSync(path.join(root, "Cargo.toml")) && commandExists("cargo")) {
    return { test: "cargo test", lint: "cargo clippy --all-targets --all-features", typecheck: "cargo check", build: "cargo build", dev: "cargo run" }[name];
  }
  if (fs.existsSync(path.join(root, "go.mod")) && commandExists("go")) {
    return { test: "go test ./...", lint: "go vet ./...", typecheck: "go vet ./...", build: "go build ./...", dev: "go run ." }[name];
  }
  return null;
}

function detectPackageCommand(root, name) {
  const pkgPath = path.join(root, "package.json");
  if (!fs.existsSync(pkgPath)) return null;
  let pkg;
  try { pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")); }
  catch { return null; }
  const scripts = pkg.scripts || {};
  if (!scripts[name]) {
    const dependencies = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    if (name === "typecheck" && dependencies.typescript && commandExists("npx")) return "npx --no-install tsc --noEmit";
    return name === "test" && scripts.test ? packageRun(root, "test") : null;
  }
  return packageRun(root, name);
}

function packageRun(root, script) {
  if ((fs.existsSync(path.join(root, "bun.lock")) || fs.existsSync(path.join(root, "bun.lockb"))) && commandExists("bun")) return `bun run ${script}`;
  if (fs.existsSync(path.join(root, "pnpm-lock.yaml")) && commandExists("pnpm")) return `pnpm run ${script}`;
  if (fs.existsSync(path.join(root, "yarn.lock")) && commandExists("yarn")) return `yarn ${script}`;
  return `npm run ${script} --silent`;
}
