# Install with OpenAI Secure MCP Tunnel

> **Recommended working path for this release.** The MCP server stays bound to your machine; there is no public ngrok URL. It does require a ChatGPT account/workspace that can use custom MCP servers and access to OpenAI Platform tunnels.

[← Back to README](../README.md) · [Why not ngrok first?](INSTALL-NGROK.md) · [OpenAI's official tunnel guide](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)

## Before you begin

You need [Node.js 20 or later](https://nodejs.org/en/download), Git, npm, an eligible [ChatGPT account](https://chatgpt.com/), access to [OpenAI Platform](https://platform.openai.com/), and [tunnel-client](https://github.com/openai/tunnel-client/releases/latest). The ability to create custom MCP connections is controlled by your account/workspace administrator; [check eligibility here](https://developers.openai.com/api/docs/guides/custom-mcp-server).

**Safety:** Choose a small test project as `WORKSPACE_ROOTS`. Do not paste API keys into ChatGPT, commit them, or include them in screenshots.

## 1. Install the project

macOS/Linux terminal:

```bash
git clone https://github.com/Veer376/chatgpt-local-system.git
cd chatgpt-local-system
npm ci
```

Windows PowerShell:

```powershell
git clone https://github.com/Veer376/chatgpt-local-system.git
cd chatgpt-local-system
npm ci
```

Node versions below 20 are unsupported. This is a source checkout for now; **we don't yet ship a one-command `npx` or `uvx` installer**.

## 2. Create your OpenAI tunnel

1. Open [OpenAI Platform tunnel settings](https://platform.openai.com/settings/organization/tunnels). Select the **same organization/workspace** you will use in ChatGPT.
2. Create a tunnel. This requires **Tunnels Read + Manage** permission. Copy the resulting `tunnel_...` ID.
3. Create a [runtime API key](https://platform.openai.com/settings/organization/api-keys) with **Tunnels Read + Use**. The tunnel must be associated with your target ChatGPT workspace, not merely the Platform organization.
4. Download [the latest tunnel-client release](https://github.com/openai/tunnel-client/releases/latest) for your OS. On macOS, the documented Homebrew route is:

```bash
brew install openai/tools/tunnel-client
tunnel-client help quickstart
```

On Linux/Windows, download the binary from the releases page, install it somewhere on `PATH`, and verify `tunnel-client help quickstart` works. Use the release's OS-specific installation instructions.

**Permissions missing?** Ask your organization admin for the tunnel roles and the ChatGPT workspace's custom MCP app permission. These are separate settings.

## 3. Guided Local System configuration

macOS / Linux:

```bash
./scripts/connect-chatgpt.sh
```

Windows PowerShell:

```powershell
.\scripts\windows\configure-tunnel.ps1
```

This wizard requests a tunnel ID, a runtime API key (**hidden at the prompt** on macOS/Linux), workspace roots, a default workspace, and a tunnel profile. It writes the user runtime config. Keep it private. You can also review defaults in [`.env.example`](../.env.example).

Use an actual existing project directory, not your entire home directory. Don't enter the string `/Users/you/projects` unless that directory really exists on your machine.

## 4. Run the bridge and tunnel

```bash
npm run start:all
```

Leave the terminal running during the setup. In another terminal, verify the local components:

macOS/Linux:

```bash
curl -f http://127.0.0.1:8765/readyz
curl -f http://127.0.0.1:8766/readyz
```

Windows PowerShell:

```powershell
Invoke-RestMethod http://127.0.0.1:8765/readyz
Invoke-RestMethod http://127.0.0.1:8766/readyz
```

The bridge should report **11** model-facing tools. The tunnel readiness endpoint should also succeed. If the tunnel-client's health port is configured differently, use its configured port.

## 5. Connect it in ChatGPT

1. Open [ChatGPT Plugins](https://chatgpt.com/plugins). Make sure you're using the intended account/workspace and that custom MCP server creation is permitted.
2. Select **+ → Add custom MCP server**.
3. Name it **Local System**.
4. In **Connection**, select **Tunnel**, then choose your tunnel or paste its `tunnel_...` ID.
5. In **Authentication**, select **No authentication** **only for this private Secure MCP Tunnel path**.
6. Read the risk warning, acknowledge it, and create the plugin.
7. Install/enable the newly created plugin, open a supported ChatGPT conversation (use Work mode if required by your account), and select the Local System plugin.
8. Ask: *“Use Local System to show the current workspace and top-level files only. Do not modify anything.”*

**Why “No authentication” here?** It applies only to the local MCP hop behind OpenAI's authenticated private tunnel, **not** to public ngrok or ordinary HTTPS. Never reuse that setting for public Internet access.

The ChatGPT Plugins user interface changes over time. [Official step-by-step instructions](https://developers.openai.com/api/docs/guides/custom-mcp-server) are authoritative if labels move.

## 6. Install the companion Chrome extension (optional)

<a href="https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world#load-unpacked"><img src="assets/setup/chrome-extensions.png" alt="Official Chrome Extensions instructions highlighting Developer mode and Load unpacked. Opens Google's tutorial." width="620" /></a>

<sub>Open the original Google installation guide by clicking the screenshot.</sub>

1. Type `chrome://extensions` into Chrome's address bar.
2. Enable **Developer mode**, select **Load unpacked**, and choose the cloned `extensions/local-system` folder.
3. Copy the ID of the Local System extension.
4. Set `LOCAL_EXTENSION_ORIGIN=chrome-extension://YOUR_EXTENSION_ID` in **the same runtime configuration used by the bridge** (`~/.config/chatgpt-local-system/runtime.env` on macOS/Linux, the wizard's per-user location on Windows).
5. Restart `npm run start:all`, reload the extension, and refresh ChatGPT.

If the extension ID changes, update that setting. It is a local browser identity, not your tunnel ID.

[Chrome's official tutorial](https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world#load-unpacked)

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| Tunnel doesn't appear in ChatGPT | Platform **Tunnels Read + Use**, correct ChatGPT workspace association, correct selected account. |
| Tool discovery shows zero tools | Check both `readyz` endpoints, keep `start:all` running, and refresh tool scanning. |
| 8766 already in use | A tunnel-client instance may already be running. Check the existing listener first; don't launch duplicate tunnel clients. |
| Extension can't access files | Local bridge is running; `LOCAL_EXTENSION_ORIGIN` matches Chrome's installed extension ID; project root is authorized. |
| macOS permission prompt doesn't appear | Check [operational guidance](OPERATIONS.md) and your interactive approval setup. |
| “Create” option missing in ChatGPT | The required plugin creation permission may be unavailable to your account/workspace. |

**Stopping:** Stop the foreground process with Ctrl+C. Revoke API keys and disable the custom plugin if you no longer want access. Deleting a Chrome extension does **not** stop a separately running local MCP server.

## Official references

[OpenAI Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels) · [Add custom MCP server](https://developers.openai.com/api/docs/guides/custom-mcp-server) · [tunnel-client releases](https://github.com/openai/tunnel-client/releases/latest) · [Chrome unpacked extension](https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world#load-unpacked)
