# Contributing to Local System

Local System is a high-authority bridge between ChatGPT and a developer's computer. Contributions are welcome, but changes that affect command execution, filesystem authority, authentication, approvals, or public-network exposure need stronger review than ordinary UI/documentation changes.

## Before opening a pull request

1. Search existing issues and pull requests for the same problem.
2. For a security vulnerability, **do not open a public issue**. Follow [the security reporting process](docs/SECURITY.md#reporting-a-vulnerability).
3. Keep a change focused. Large refactors mixed with product changes are difficult to review safely.
4. Never commit real API keys, tunnel credentials, private logs, user paths, device IDs, or screenshots from a personal ChatGPT account.

## Development setup

```bash
git clone https://github.com/Veer376/chatgpt-local-system.git
cd chatgpt-local-system
npm ci
npm run build
```

Requirements and platform expectations are listed in [the support matrix](docs/SUPPORT.md). For a real ChatGPT connection, follow the [Secure MCP Tunnel guide](docs/INSTALL-SECURE-TUNNEL.md); the public ngrok path is still advanced/manual.

## Run checks

Use the smallest relevant checks while iterating, then the broader suite before submitting:

```bash
npm run lint
npm run test:unit
npm run test:integration
npm run test:browser
npm run check
npm run smoke:clone
```

`npm run smoke:clone` is intentionally different from normal tests: it verifies that **committed files alone** can be cloned, installed, built, started on an isolated loopback port, and exercised through MCP.

Browser tests can expose timing regressions. If a test appears flaky, reproduce it directly and report both the isolated result and the full-suite result rather than simply increasing timeouts.

## Pull-request expectations

- Explain the user problem and why the proposed behavior is appropriate.
- Add or update tests for behavior changes.
- Update documentation when configuration, security boundaries, platform support, or user-visible setup changes.
- Call out any new data flow, network destination, credential, executable, filesystem root, permission, or destructive action.
- Preserve safe defaults. Security bypasses must never become the default to make a test or demo easier.
- Keep generated/vendor files out of review unless the change actually requires them.

For tool-contract changes, update the authoritative technical reference and contract tests. For extension UI changes, keep behavior compatible with the current ChatGPT surface and verify the side-panel fallback where relevant.

## Issue quality

A useful bug report includes:

- Local System commit or version;
- OS and architecture;
- Node.js version;
- connection path (Secure MCP Tunnel, advanced ngrok gateway, or direct local MCP);
- whether the Chrome extension is enabled;
- exact reproduction steps and expected/actual behavior;
- sanitized `npm run doctor -- --json` output when setup/runtime health is relevant.

Remove secrets and unnecessary local paths before posting. Prefer a minimal sample project over private production data.

## Versioning and changelog

Local System uses [Semantic Versioning](https://semver.org/) for tagged releases:

- **PATCH** — backward-compatible fixes, documentation, and internal hardening that does not intentionally change public behavior;
- **MINOR** — backward-compatible features or meaningful new supported behavior;
- **MAJOR** — incompatible MCP/configuration/storage behavior or other migration-requiring changes.

`package.json` is the source version inside a checkout. For a tagged release, the package version, Git tag (`vX.Y.Z`), and release notes should agree. User-visible changes belong under **Unreleased** in [CHANGELOG.md](CHANGELOG.md) and are moved into a dated version section when a release is cut.

The repository entered public history with `package.json` already at `1.0.0`; version tags/releases are applied prospectively rather than inventing historical tags.

## License

By contributing, you agree that your contribution is provided under the repository's [MIT License](LICENSE).
