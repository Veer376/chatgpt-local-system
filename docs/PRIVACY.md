# Privacy and data flow

Local System is primarily local software, but its purpose is to let ChatGPT work with selected information and actions on your computer. “Local” therefore does **not** mean “nothing leaves the machine.”

## What can be sent to ChatGPT

Depending on the tools/features you use, ChatGPT can receive:

- MCP tool requests and returned results;
- file contents you explicitly attach with `@@` or otherwise ask the bridge to read;
- selected skill instructions attached with `//`;
- command output and patch/file-operation results;
- workspace/project metadata needed to resolve requested files;
- annotations and feedback you intentionally insert into the conversation.

ChatGPT/OpenAI handles that information according to the account, workspace, and product policies applying to your ChatGPT session. Local System does not control OpenAI-side retention or training settings.

## What stays on the computer by default

Local System stores operational data under the current OS account, including:

- per-user runtime configuration (normally `~/.config/chatgpt-local-system/runtime.env` on Unix-like systems);
- state, logs, process metadata, approval state, and audit events under `~/.chatgpt-local-system/`;
- agent-visible scratch outputs under `~/.local-system/scratch/` by default;
- browser-extension UI/workspace state in the browser's extension storage where applicable.

Connected project files remain in their original locations unless a tool, command, user action, or project script explicitly creates/copies/modifies them.

`stop` and service `uninstall` intentionally **do not delete** runtime configuration, logs, state, or project files. See [operations](OPERATIONS.md) before removing local state manually.

## Network paths

The normal private setup uses OpenAI's Secure MCP Tunnel to connect ChatGPT to the loopback-bound bridge. Advanced users may operate a separately authenticated HTTPS/ngrok gateway. Those services have their own terms and data handling.

Commands, project scripts, package managers, delegated agents, and optional tools executed through Local System can make their own network requests. Workspace restrictions are not a network sandbox.

The current repository does not intentionally add a Local System analytics/advertising service. Third-party libraries, websites, CLIs, and services that you invoke can have their own telemetry or privacy behavior.

## Credentials

Do not attach secret files to ChatGPT unless you deliberately intend to send them. The bridge filters secret-like environment variables from command children by default, but generic command authority under the same OS account can still reach files that account can read unless an OS sandbox prevents it.

Runtime/tunnel credentials should stay in the per-user secret configuration and must never be committed or posted in issues. See [the security model](SECURITY.md).

## Removing access or local data

- Disable/remove the custom ChatGPT MCP connection to stop ChatGPT from invoking it.
- Stop Local System or uninstall its service registration to stop local serving.
- Revoke tunnel/API credentials at their provider when access should no longer work.
- Remove the Chrome extension to disable its composer/workspace integration.
- Delete Local System's config/state/scratch directories manually only after reviewing what you need to keep.

If you are reporting a privacy or security vulnerability, use the [private security reporting process](SECURITY.md#reporting-a-vulnerability), not a public issue.
