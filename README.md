<!-- LOGO SLOT: replace this existing square icon with the finalized Local System identity later. -->
<div align="center">
  <img src="extensions/local-system/icons/local-system-128.png" alt="Local System icon" width="72" />
  <h1>Local System</h1>
  <p><strong>Bring your computer into ChatGPT.</strong></p>
  <p>Attach local files and skills while you write a prompt. Browse your project beside the chat. Let ChatGPT work with your local tools and files.</p>
  <p>
    <a href="#get-started">Get started</a> ·
    <a href="#the-two-shortcuts">Try the shortcuts</a> ·
    <a href="docs/INSTALL-SECURE-TUNNEL.md">Install guide</a> ·
    <a href="docs/INSTALL-NGROK.md">ngrok</a>
  </p>
</div>

---

## The two shortcuts

Type directly in the **ChatGPT message composer**. Local System adds two searchable pickers so you do not need to manually open Finder, copy a file path, or paste a skill's instructions.

<table>
  <tr>
    <th width="50%">Attach a skill</th>
    <th width="50%">Attach a local file</th>
  </tr>
  <tr>
    <td><h3><kbd>//</kbd> Skills</h3>Type <code>//</code> followed by a skill name to search your locally registered skills.<br /><br /><code>//code-review</code><br /><br />Choose a result → Local System adds a removable skill chip and the <code>/skill-name</code> marker to your prompt. On send, the registered <code>SKILL.md</code> content is supplied to ChatGPT.</td>
    <td><h3><kbd>@@</kbd> Files</h3>Type <code>@@</code> followed by a file name to search authorized local project files.<br /><br /><code>@@src/server.js</code><br /><br />Choose a result → Local System attaches the actual file through ChatGPT's composer, not merely a text path. Search prioritizes the active workspace.</td>
  </tr>
</table>

**Example:** Type `//code-review` to select a review skill, then `@@src/server.js` to attach the source file. Ask ChatGPT to review it using that skill. The exact available skills and files depend on your local configuration.

> Attaching a file or skill sends its selected content to ChatGPT. Do not select confidential files or skill instructions unless you intend to share them with ChatGPT.

## More than a local terminal

The composer shortcuts are one part of the experience. Local System combines a small MCP bridge with a ChatGPT-integrated workspace, rather than leaving you to move between a shell, an editor, and a conversation.

<table>
  <tr>
    <td width="50%"><strong>Project workspace beside the chat</strong><br />A native Chrome side panel for browsing the project tree, switching files, searching, editing source, and reviewing changes. Open files without leaving your conversation.</td>
    <td><strong>Clickable paths in ChatGPT replies</strong><br />Paths in responses open the corresponding authorized local file. Relative paths resolve within the selected project or conversation context instead of searching your entire computer.</td>
  </tr>
  <tr>
    <td><strong>Previews that match the file</strong><br />View images, PDFs, videos, rendered Markdown and sandboxed HTML. Move from source to preview in the workspace, with supported preview types depending on the file.</td>
    <td><strong>Feedback with context</strong><br />Annotate files and selected text, leave timestamped video notes, and pass structured <code>[Annotations]</code> back into the ChatGPT composer.</td>
  </tr>
  <tr>
    <td><strong>Commands, tasks, and memory</strong><br />Run tools against authorized projects, follow longer-running tasks, carry conversation-scoped todos, and resume work from runtime checkpoints.</td>
    <td><strong>Local control and approvals</strong><br />Eleven fixed MCP tools, configured file roots, audit information, and confirmation for classified destructive operations by default. This is <strong>not</strong> an OS sandbox.</td>
  </tr>
</table>

These capabilities are Local System's focus, **not** a claim that no other project has similar features. For shortcuts, workspace behavior and keyboard commands, see the [extension reference](extensions/local-system/README.md).

<!-- PRODUCT DEMO SLOT: Add a real, sanitized screenshot or short GIF of the Local System side panel/composer here. Do not use unrelated website screenshots. -->

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
