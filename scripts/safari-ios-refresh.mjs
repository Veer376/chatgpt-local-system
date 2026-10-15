import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const safariRoot = path.join(repoRoot, ".safari-ios");
const configPath = path.join(safariRoot, "config.json");
const options = new Set(process.argv.slice(2));
const config = readConfig();
const appName = config.appName || "Local System";
const bundleId = config.bundleId || "dev.localsystem.app";
const projectDir = path.join(safariRoot, "xcode");
const projectPath = path.join(projectDir, appName, `${appName}.xcodeproj`);
const derivedData = path.join(safariRoot, "DerivedData");
const stagedExtension = path.join(safariRoot, "extension");
const appPath = path.join(derivedData, "Build", "Products", "Debug-iphoneos", `${appName}.app`);

run(process.execPath, [
  path.join(repoRoot, "scripts", "prepare-safari-ios.mjs"),
  "--origin", config.origin,
  "--username", config.username || "local-system",
  "--password-file", resolveConfigPath(config.passwordFile),
]);

if (!fs.existsSync(projectPath)) {
  fs.mkdirSync(projectDir, { recursive: true });
  run("xcrun", [
    "safari-web-extension-packager", stagedExtension,
    "--project-location", projectDir,
    "--app-name", appName,
    "--bundle-identifier", bundleId,
    "--ios-only", "--swift", "--no-open", "--no-prompt", "--force",
  ]);
} else {
  const missingResources = missingProjectResources(projectPath, stagedExtension);
  if (missingResources.length) {
    console.log(`[safari-ios-refresh] rebuilding wrapper for new extension resources: ${missingResources.join(", ")}`);
    run("xcrun", [
      "safari-web-extension-packager", stagedExtension,
      "--rebuild-project", projectPath,
      "--app-name", appName,
      "--bundle-identifier", bundleId,
      "--ios-only", "--swift", "--no-open", "--no-prompt", "--force",
    ]);
  }
}

normalizeParentBundleId(projectPath, bundleId);

run("xcodebuild", [
  "-project", projectPath,
  "-scheme", appName,
  "-configuration", "Debug",
  "-destination", `platform=iOS,id=${config.deviceId}`,
  "-derivedDataPath", derivedData,
  `DEVELOPMENT_TEAM=${config.developmentTeam}`,
  "CODE_SIGN_STYLE=Automatic",
  "-allowProvisioningUpdates",
  "build",
]);

run("xcrun", ["devicectl", "device", "install", "app", "--device", config.deviceId, appPath]);
if (!options.has("--no-launch")) {
  run("xcrun", ["devicectl", "device", "process", "launch", "--device", config.deviceId, bundleId], { allowFailure: true });
}
console.log(`[safari-ios-refresh] installed ${bundleId} on ${config.deviceId}${options.has("--no-launch") ? " (Safari stays open)" : ""}`);

function readConfig() {
  if (!fs.existsSync(configPath)) {
    throw new Error(`missing ${configPath}; create the local ignored Safari development config first`);
  }
  const value = JSON.parse(fs.readFileSync(configPath, "utf8"));
  for (const key of ["origin", "passwordFile", "deviceId", "developmentTeam"]) {
    if (!value[key]) throw new Error(`Safari development config is missing ${key}`);
  }
  return value;
}

function resolveConfigPath(value) {
  return path.isAbsolute(value) ? value : path.resolve(repoRoot, value);
}

function normalizeParentBundleId(xcodeProjectPath, parentBundleId) {
  const pbxproj = path.join(xcodeProjectPath, "project.pbxproj");
  let text = fs.readFileSync(pbxproj, "utf8");
  let replacements = 0;
  text = text.replace(/PRODUCT_BUNDLE_IDENTIFIER = ([^;]+);/g, (match, rawValue) => {
    const value = String(rawValue).replace(/^"|"$/g, "");
    if (value.endsWith(".Extension")) return match;
    replacements += 1;
    return `PRODUCT_BUNDLE_IDENTIFIER = ${parentBundleId};`;
  });
  if (replacements < 1) throw new Error("could not locate parent app bundle identifier in generated Xcode project");
  fs.writeFileSync(pbxproj, text);
}

function missingProjectResources(xcodeProjectPath, extensionPath) {
  const pbxproj = path.join(xcodeProjectPath, "project.pbxproj");
  if (!fs.existsSync(pbxproj)) return ["project.pbxproj"];
  const project = fs.readFileSync(pbxproj, "utf8");
  return fs.readdirSync(extensionPath, { withFileTypes: true })
    .filter((entry) => !entry.name.startsWith("."))
    .filter((entry) => entry.isFile() || entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => !project.includes(name));
}

function run(command, args, { allowFailure = false } = {}) {
  const result = spawnSync(command, args, { cwd: repoRoot, stdio: "inherit", env: process.env });
  if (result.error) throw result.error;
  if (!allowFailure && result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status}`);
  }
  return result.status;
}
