# Local System for ChatGPT

First-class Chrome extension for the Local System project. It augments `https://chatgpt.com` with local-machine UI and file workflows while keeping filesystem access behind the loopback Local System server.

## Features

- Clickable authorized local-file paths in ChatGPT responses. Clicking the path opens that file in the right-side Local System workspace. Absolute paths resolve directly; relative paths prefer the thread's current workspace and then conversation scratch.
- Inline previews for referenced images and PDF files. Clicking a preview opens the larger preview dialog; Markdown, code, and other file types intentionally remain path-only rather than rendering an inline preview.
- Thread-scoped todos above the composer.
- `//query` skill picker and `@@query` local file picker. `@@` can search authorized project roots even before a conversation binding exists, while preferring the current workspace when one is available. Selecting a skill keeps a `/skill-name` marker at the invocation point, attaches a colored removable chip above the composer, and on send appends its exact registered `SKILL.md` path and full contents inside a `<skill>...</skill>` block.
- `⌘P` quick-open for authorized project files.
- Native right-side file workspace with tabs, direct syntax-highlighted text editing, explicit `⌘S`/✓ saves (no autosave), media previews, resizing, and file annotations.
- A passive workspace indicator at the far right above the composer when the thread has a current workspace.
- Response and file annotations serialized into outgoing prompts as `[Annotations] ... [/Annotations]`.
- `⌘B` toggles ChatGPT's native left sidebar.
- `⌘⇧E` toggles the Local System file workspace.

Normal `/c/<thread>` URLs and ChatGPT Project URLs containing `/g/g-p-.../c/<thread>` are both recognized as the same browser-thread shape.

## Runtime dependency

The extension is a browser UI client; it does **not** read arbitrary local files directly. It calls the Local System loopback server at:

```text
http://127.0.0.1:8765
```

The same `src/server.js` process serves both MCP and extension endpoints, including:

```text
/mcp
/local-image/*
/local-ui/todos
/local-ui/files/*
/local-ui/skills
/local-ui/annotations
/local-ui/file-workspace
```

Therefore the server must be running for local-file resolution and previews, todos, skill resolution/attachment persistence, local file discovery/content/editing, annotations persistence, and the file workspace to work. Pure DOM conveniences such as `⌘B` do not require the server.

Use the project runtime entry point:

```bash
npm run start:all
```

`start:all` builds project artifacts, automatically loads the user runtime configuration from `~/.config/chatgpt-local-system/runtime.env` on macOS/Linux (or `%APPDATA%\\chatgpt-local-system\\runtime.env` on Windows), starts `src/server.js`, and starts the configured secure MCP tunnel. No `BRIDGE_ENV_FILE=...` prefix is needed for the normal setup. The extension itself remains loaded by Chrome; it is not a separate daemon.

## Build

```bash
npm run build:extension
```

This rebuilds `vendor/highlight.bundle.js` from `highlight-entry.js`. `npm run build`, `npm start`, and `npm run start:all` also rebuild it.

## Load in Chrome

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Choose **Load unpacked**.
4. Select this directory: `extensions/local-system`.
5. After source changes, press **Reload** on the extension card and refresh ChatGPT.

The server host/port is currently intentionally fixed to loopback `127.0.0.1:8765`, matching the project runtime defaults.

The server also validates the Chrome extension origin. Set `LOCAL_EXTENSION_ORIGIN`
in the per-user `runtime.env` to this unpacked extension's
`chrome-extension://<id>` origin. When the unpacked extension directory moves,
Chrome can assign a different ID; the server accepts a comma-separated list of
origins to make migrations safe.
