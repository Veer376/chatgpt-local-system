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

Local System combines a **ChatGPT composer extension**, an **in-chat project workspace**, and an **MCP bridge** for working on your computer. The most immediate difference is that files and reusable skills are available while you are writing a message, instead of requiring you to copy content between apps.

<table>
  <thead>
    <tr><th colspan="2" align="left">Attach context without leaving ChatGPT</th></tr>
  </thead>
  <tbody>
    <tr>
      <td width="50%" valign="top">
        <h3><kbd>//</kbd> Attach local skills</h3>
        <p>Search registered skills directly inside the message composer. Pick a skill instead of opening and copying its instructions.</p>
        <p><strong>Type:</strong> <code>//code-review</code></p>
        <p><strong>Then:</strong> select a result → a removable skill chip and <code>/skill-name</code> marker appear → the selected <code>SKILL.md</code> instructions are included when you send.</p>
        <sub>Example name only: your available skills come from your own local configuration.</sub>
      </td>
      <td width="50%" valign="top">
        <h3><kbd>@@</kbd> Attach project files</h3>
        <p>Find files in your authorized local projects from the same composer. Choose a result to attach the actual file, not just paste its path.</p>
        <p><strong>Type:</strong> <code>@@src/server.js</code></p>
        <p><strong>Then:</strong> select a result → the file attaches to the ChatGPT prompt. Search prefers the current project, with authorized roots available when needed.</p>
        <sub>No manual Finder navigation or file copying. Only attach content you intend to share.</sub>
      </td>
    </tr>
    <tr>
      <td colspan="2" align="center">
        <strong>Example: review a file with your own instructions</strong>
        <p><code>//code-review</code> &nbsp; + &nbsp; <code>@@src/server.js</code> &nbsp; → &nbsp; “Review this file using the attached skill.”</p>
        <sub>Both pickers are part of the optional Chrome extension; the local bridge must be running.</sub>
      </td>
    </tr>
    <tr><th colspan="2" align="left">Explore, edit, and discuss your project</th></tr>
    <tr>
      <td valign="top">
        <h3>Project workspace beside the conversation</h3>
        <p>Keep a file explorer and editor alongside ChatGPT with a right-side Chrome panel: navigate project folders, search, open tabs, inspect changes, edit text, and explicitly save.</p>
        <p><strong>In practice:</strong> ask ChatGPT to make a change, then inspect the resulting files without switching to another editor.</p>
      </td>
      <td valign="top">
        <h3>Clickable file references in replies</h3>
        <p>When ChatGPT mentions an authorized local file path, open it in the Local System workspace by clicking the reference.</p>
        <p><strong>In practice:</strong> jump from <code>src/server.js</code> in an answer to the actual file. Relative paths use the selected project rather than a filesystem-wide search.</p>
      </td>
    </tr>
    <tr>
      <td valign="top">
        <h3>Rich previews for real project files</h3>
        <p>Open code, rendered Markdown, sandboxed HTML, images, PDFs, and video in the workspace. Switch between source and preview where supported.</p>
        <p><strong>In practice:</strong> inspect an HTML page or a generated image directly beside the conversation.</p>
      </td>
      <td valign="top">
        <h3>Annotations ChatGPT can act on</h3>
        <p>Comment on selected text, files, rendered content, and moments in videos. Local System returns structured feedback to the composer.</p>
        <p><strong>In practice:</strong> mark a video timestamp or highlight a code section, then send the resulting <code>[Annotations]</code> back for a precise correction.</p>
      </td>
    </tr>
    <tr><th colspan="2" align="left">Run work locally and stay in control</th></tr>
    <tr>
      <td valign="top">
        <h3>Local tools and long-running tasks</h3>
        <p>Give ChatGPT access to an explicit 11-tool MCP surface: read context, apply patches, run commands, discover skills, inspect media, and track work.</p>
        <p><strong>In practice:</strong> let a build or test run continue as a managed task, with thread-aware todos and runtime checkpoints for follow-up calls.</p>
      </td>
      <td valign="top">
        <h3>Workspace scope and human approval</h3>
        <p>Choose authorized project roots, review audit information, and confirm classified destructive operations by default.</p>
        <p><strong>Important:</strong> shell execution still has your OS account's authority. Approval checks and path restrictions are <strong>not a sandbox</strong>.</p>
      </td>
    </tr>
  </tbody>
</table>

<sub>Feature availability varies by context: composer pickers, file previews, annotations, and the side panel require the Chrome extension; MCP tools work independently through the bridge. These are Local System's focus, not a claim that other projects cannot offer similar capabilities.</sub>

For shortcut syntax, workspace behavior and keyboard commands, see the [extension reference](extensions/local-system/README.md).

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
