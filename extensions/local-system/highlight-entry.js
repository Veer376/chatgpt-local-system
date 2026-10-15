import hljs from "highlight.js/lib/core";
import javascript from "highlight.js/lib/languages/javascript";
import typescript from "highlight.js/lib/languages/typescript";
import python from "highlight.js/lib/languages/python";
import json from "highlight.js/lib/languages/json";
import xml from "highlight.js/lib/languages/xml";
import css from "highlight.js/lib/languages/css";
import bash from "highlight.js/lib/languages/bash";
import sql from "highlight.js/lib/languages/sql";
import java from "highlight.js/lib/languages/java";
import csharp from "highlight.js/lib/languages/csharp";
import cpp from "highlight.js/lib/languages/cpp";
import c from "highlight.js/lib/languages/c";
import go from "highlight.js/lib/languages/go";
import rust from "highlight.js/lib/languages/rust";
import yaml from "highlight.js/lib/languages/yaml";
import markdown from "highlight.js/lib/languages/markdown";
import kotlin from "highlight.js/lib/languages/kotlin";
import swift from "highlight.js/lib/languages/swift";
import ruby from "highlight.js/lib/languages/ruby";
import php from "highlight.js/lib/languages/php";
import ini from "highlight.js/lib/languages/ini";
import dockerfile from "highlight.js/lib/languages/dockerfile";

const registrations = {
  javascript,
  typescript,
  python,
  json,
  xml,
  css,
  bash,
  sql,
  java,
  csharp,
  cpp,
  c,
  go,
  rust,
  yaml,
  markdown,
  kotlin,
  swift,
  ruby,
  php,
  ini,
  dockerfile,
};

for (const [name, language] of Object.entries(registrations)) hljs.registerLanguage(name, language);
hljs.registerAliases(["js", "jsx", "mjs", "cjs"], { languageName: "javascript" });
hljs.registerAliases(["ts", "tsx"], { languageName: "typescript" });
hljs.registerAliases(["py"], { languageName: "python" });
hljs.registerAliases(["html", "htm", "svg"], { languageName: "xml" });
hljs.registerAliases(["sh", "zsh", "shell"], { languageName: "bash" });
hljs.registerAliases(["cs"], { languageName: "csharp" });
hljs.registerAliases(["cc", "cxx", "h", "hpp"], { languageName: "cpp" });
hljs.registerAliases(["yml"], { languageName: "yaml" });
hljs.registerAliases(["md", "mdx"], { languageName: "markdown" });
hljs.registerAliases(["rb"], { languageName: "ruby" });
hljs.registerAliases(["kt", "kts"], { languageName: "kotlin" });
hljs.registerAliases(["docker"], { languageName: "dockerfile" });

export function highlight(code, language) {
  const normalized = String(language || "").toLowerCase();
  if (normalized && hljs.getLanguage(normalized)) {
    return { html: hljs.highlight(String(code || ""), { language: normalized, ignoreIllegals: true }).value, language: normalized };
  }
  return { html: escapeHtml(String(code || "")), language: "plaintext" };
}

export function supported(language) {
  return Boolean(language && hljs.getLanguage(String(language).toLowerCase()));
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[char]));
}
