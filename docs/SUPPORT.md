# Support matrix

This matrix describes what the repository currently tests or documents. It is not a promise that every optional dependency or ChatGPT account configuration works on every machine.

## Support levels

- **CI-covered** — included in the repository's automated CI matrix for the listed runtime. This does not imply every current workflow run is green.
- **Implemented** — code and documentation exist, but the full OS/service/external-account path is not continuously exercised end-to-end in CI.
- **Advanced / experimental** — available for development or specialized use, but not the recommended beginner path.

## Platforms and runtimes

| Area | macOS | Linux | Windows | Notes |
| --- | --- | --- | --- | --- |
| Core Node/MCP bridge | **CI-covered** | **CI-covered** | **CI-covered** | Node.js **20 and 22** are in the CI matrix. Node 20+ is the documented requirement; newer untested majors are best-effort until added to CI. |
| Unit/integration checks | **CI-covered** | **CI-covered** | **CI-covered** | `npm run check` is configured across the OS/Node matrix. Check the current workflow status before treating a commit as release-ready. |
| Clean-clone install smoke | Manually verified on Apple silicon; script is cross-platform | **CI-covered** on Ubuntu/Node 20 | Implemented | `npm run smoke:clone` clones committed source, installs, builds, starts an isolated bridge, and performs an MCP roundtrip. |
| Managed background service | Implemented with launchd | Implemented with systemd user services | Implemented with Scheduled Tasks | Service scripts exist; CI checks code/syntax, not a real logged-in desktop service lifecycle on every OS. |
| Secure MCP Tunnel setup | Documented/used by maintainers | Implemented where `tunnel-client` is available | Implemented where `tunnel-client` is available | Requires OpenAI Platform/ChatGPT workspace permissions and a supported `tunnel-client`; these external permissions are not CI-testable. |
| Chrome companion extension | Supported/manual verification | Supported/manual verification | Supported/manual verification | Chrome desktop + Developer mode / Load unpacked. It depends on ChatGPT's evolving web UI and is not covered by every OS CI combination end-to-end. |
| `//` skills and `@@` file attachments | Extension feature | Extension feature | Extension feature | Requires the Chrome extension and running local bridge. |
| Safari/mobile helpers | **Advanced / experimental** | — | — | Not part of the beginner installation path. |
| Public ngrok MCP | **Advanced / manual only** | **Advanced / manual only** | **Advanced / manual only** | Do not expose `/mcp` anonymously. The repository does not yet ship the managed OAuth/device-pairing experience described in the product direction. |

## Supported product surface

The authoritative model-facing surface is the fixed **11-tool MCP contract** documented in [TECHNICAL_REFERENCE.md](TECHNICAL_REFERENCE.md). Generic browser automation, Office automation, arbitrary web-fetch, and OS-level sandboxing are not promises of this bridge.

## Browser and external-service compatibility

- **Chrome:** current desktop Chrome with extension Developer mode is the supported extension target.
- **ChatGPT:** custom MCP/plugin availability and exact UI labels depend on plan/workspace policy and can change independently of this repository.
- **OpenAI Secure MCP Tunnel:** support depends on the current OpenAI Platform tunnel service and `tunnel-client` releases.
- **ngrok:** account/domain/traffic-policy behavior depends on ngrok; Local System does not provide or share a maintainer credential.

## Getting help

For reproducible bugs, use the repository bug template and include sanitized diagnostic output. Feature ideas belong in the feature-request template. Security vulnerabilities must use [private vulnerability reporting](SECURITY.md#reporting-a-vulnerability).
