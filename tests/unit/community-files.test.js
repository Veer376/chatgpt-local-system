import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const read = (relative) => readFileSync(new URL(`../../${relative}`, import.meta.url), "utf8");

test("public community infrastructure stays discoverable", () => {
  for (const relative of [
    "CONTRIBUTING.md",
    "CHANGELOG.md",
    "SECURITY.md",
    "docs/PRIVACY.md",
    "docs/SUPPORT.md",
    ".github/ISSUE_TEMPLATE/bug_report.yml",
    ".github/ISSUE_TEMPLATE/feature_request.yml",
    ".github/ISSUE_TEMPLATE/config.yml",
    ".github/pull_request_template.md",
  ]) {
    assert.equal(existsSync(new URL(`../../${relative}`, import.meta.url)), true, `${relative} must exist`);
  }

  assert.match(read("SECURITY.md"), /security\/advisories\/new/);
  assert.match(read("docs/PRIVACY.md"), /What can be sent to ChatGPT/);
  assert.match(read("docs/SUPPORT.md"), /CI-covered/);
  assert.match(read("CHANGELOG.md"), /## \[Unreleased\]/);
  assert.match(read("CONTRIBUTING.md"), /Semantic Versioning/);
});
