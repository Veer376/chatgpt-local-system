<!-- LOGO SLOT: replace this existing square icon with the finalized Local System identity later. -->
<div align="center">
  <img src="extensions/local-system/icons/local-system-128.png" alt="Local System icon" width="72" />
  <h1>Local System</h1>
  <p><strong>Bring your computer into ChatGPT.</strong></p>
  <p>Attach local files and skills while you write a prompt. Browse your project beside the chat. Let ChatGPT work with your local tools and files.</p>
  <p>
    <a href="#get-started">Get started</a> ·
    <a href="#features">Try the shortcuts</a> ·
    <a href="docs/INSTALL-SECURE-TUNNEL.md">Install guide</a> ·
    <a href="docs/INSTALL-NGROK.md">ngrok</a>
  </p>
</div>

---

## Features

Local System adds four things to the ChatGPT workflow: **context in the composer, a project workspace, visual feedback, and local execution**.

<p align="center">
  <img src="docs/assets/features/feature-map.svg" width="1000" alt="Visual map of Local System features: // skills and @@ files in the ChatGPT composer, a project workspace, rich previews and annotations, and local command execution with approval." />
</p>

<table>
  <tr>
    <td width="50%" valign="top">
      <strong><code>//</code> Skills + <code>@@</code> Files</strong><br />
      Search and attach local skills or real project files while writing the prompt. A chosen skill supplies its registered <code>SKILL.md</code>; a chosen file becomes a real ChatGPT attachment.
    </td>
    <td width="50%" valign="top">
      <strong>Project workspace + clickable paths</strong><br />
      Browse, search, edit, preview, and explicitly save local project files beside the conversation. Click authorized file paths in ChatGPT replies to open the actual file.
    </td>
  </tr>
  <tr>
    <td valign="top">
      <strong>Previews + annotations</strong><br />
      Inspect images, PDFs, video, Markdown, sandboxed HTML, and code. Send selected-text notes or timestamped video feedback back as structured <code>[Annotations]</code>.
    </td>
    <td valign="top">
      <strong>Local tools + managed tasks + approval</strong><br />
      Run commands, apply patches, follow longer-running tasks, discover skills, and keep thread-aware state. Classified destructive operations require confirmation by default.
    </td>
  </tr>
</table>

**Try the two composer features:** `//code-review` + `@@src/server.js` → “Review this file using the attached skill.”

<sub>The composer pickers, workspace, previews, and annotations require the Chrome extension. MCP tools work through the bridge independently. Local shell execution is high-authority and is not an OS sandbox.</sub>

[Extension features and shortcuts →](extensions/local-system/README.md)

## Get started

### 1. Clone and install

You need **Node.js 20+**, npm, Git, and a supported ChatGPT account/workspace with custom MCP access. Chrome is required for the optional browser extension.

```bash
git clone https://github.com/Veer376/chatgpt-local-system.git
cd chatgpt-local-system
npm ci
```

### 2. Choose how ChatGPT connects

<table>
  <tr><th>Connection</th><th>Status and next step</th></tr>
  <tr>
    <td><strong><a href="docs/INSTALL-NGROK.md">ngrok / HTTPS</a></strong><br />Our goal: a simple sign-in and device-pairing setup.</td>
    <td><strong>Advanced only today.</strong> Requires an independently configured ChatGPT-compatible OAuth gateway. The automated OAuth connection is not yet built.<br /><a href="docs/INSTALL-NGROK.md">Understand ngrok and its security requirements →</a></td>
  </tr>
  <tr>
    <td><strong><a href="docs/INSTALL-SECURE-TUNNEL.md">OpenAI Secure MCP Tunnel</a></strong><br />No publicly reachable MCP URL.</td>
    <td><strong>Working setup path today.</strong> Requires OpenAI Platform tunnel access and the local tunnel client.<br /><a href="docs/INSTALL-SECURE-TUNNEL.md">Follow the installation guide →</a></td>
  </tr>
</table>

**Important:** Do not run `ngrok http 8765` and connect with “No authentication.” Local System can execute local commands. A public, anonymous endpoint would give others access. The [ngrok guide](docs/INSTALL-NGROK.md) explains the safe architecture without pretending it is one-click today.

### 3. Add the Chrome extension (optional)

The MCP bridge can work without it; the extension adds the file workspace, the `//` and `@@` pickers, previews, and annotations.

1. Open `chrome://extensions` in Chrome.
2. Turn on **Developer mode**, then select **Load unpacked**.
3. Select this repository's `extensions/local-system` folder.
4. Configure `LOCAL_EXTENSION_ORIGIN=chrome-extension://YOUR_EXTENSION_ID` for the running bridge. Reload the extension and refresh ChatGPT.

<p>
  <a href="https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world#load-unpacked">
    <img src="docs/assets/setup/chrome-extensions.png" width="620" alt="Official Chrome extension installation screenshot showing Developer mode and Load unpacked. Click to open Google's step-by-step guide." />
  </a>
</p>
<sub>Screenshot: Google Chrome Developers. Click the image for the full installation guide—not an enlarged image file.</sub>

[Full extension configuration](extensions/local-system/README.md)

### 4. Run a read-only test

In ChatGPT, enable the Local System MCP connection and ask:

> Show my current project workspace and list the top-level files. Don't modify anything.

Then try typing `//` or `@@` in the composer with the Chrome extension enabled.

## How it works

```text
ChatGPT ── Secure MCP Tunnel / authorized HTTPS gateway ── Local System bridge
                                                               │
                                                     Local files and commands
                                                     Tasks, skills, approval
                                                               │
Chrome extension ───────── authenticated loopback API ─────────┘
       │
       └── // skills · @@ files · workspace · previews · annotations
```

The bridge exposes **11 MCP tools**: `bridge_context`, `workspace`, `display`, `view_image`, `apply_patch`, `execute_command`, `manage_task`, `request_user_input`, `write_todos`, `runtime_memory`, and `discover_skills`.

There is no required Local System cloud account. The extension is a client of the local Node.js server; it is **not** a standalone local filesystem server.

## Read this before giving it access

- **High authority:** local shell processes run with the privileges of the current OS account; workspace roots are not an OS-level sandbox.
- **Approval model:** classified destructive operations require approval by default. Other commands can still have side effects.
- **Network:** keep `/mcp` private unless you operate and verify an authenticated gateway. Never publicly expose the local `/local-ui/*`, `/local-file/*`, or `/local-image/*` endpoints.
- **Data sharing:** selected file attachments, skills, and tool outputs can be sent to ChatGPT.
- **Compatibility:** the extension depends on ChatGPT's evolving web interface; custom MCP availability varies by plan/workspace.

Read the [security model](docs/SECURITY.md) and [operational notes](docs/OPERATIONS.md).

<details>
<summary><strong>Troubleshooting and more documentation</strong></summary>

| Problem | First check |
| --- | --- |
| MCP tools missing | Is the bridge ready at `http://127.0.0.1:8765/readyz`? Is your chosen tunnel running? |
| `//` or `@@` doesn't appear | Is the unpacked extension loaded and ChatGPT refreshed? Is the loopback bridge available? |
| File workspace empty | Does `LOCAL_EXTENSION_ORIGIN` match the installed Chrome extension ID? Are the project roots allowed? |
| Connection setup too complex | Start with the [Secure MCP Tunnel guide](docs/INSTALL-SECURE-TUNNEL.md); ngrok OAuth onboarding is still planned. |

[Existing technical reference](docs/TECHNICAL_REFERENCE.md) · [OpenAI custom MCP setup](https://developers.openai.com/api/docs/guides/custom-mcp-server) · [ngrok documentation](https://ngrok.com/docs/) · [Chrome extension setup](https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world#load-unpacked)

</details>

## Contributing

Issues, bug reproductions, accessibility improvements, and focused pull requests are welcome. The biggest open product experience gap is easy, secure OAuth/device onboarding for ngrok. See the [technical reference](docs/TECHNICAL_REFERENCE.md) for internals.

**License:** [MIT](LICENSE). Local System is an independent project, not an official OpenAI or ngrok product.
