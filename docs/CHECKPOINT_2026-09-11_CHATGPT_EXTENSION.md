# Checkpoint — ChatGPT Local UI Bridge

Date: 2026-09-11

This checkpoint captures the first proven end-to-end ChatGPT browser-extension integration layer for Local System.

## Proven working

- Local images can be resolved through the loopback bridge and rendered inline in ChatGPT without base64 or direct `file://` access.
- Inline images render as compact rounded thumbnails above their local path and open into a larger lightbox on click.
- The browser extension binds the visible ChatGPT `/c/<thread-id>` to the correct Local System conversation scope and keeps per-thread todo state isolated.
- `write_todos` remains available to the model while its MCP rich UI is disabled at runtime (`TOOL_UI_WRITE_TODOS=false`).
- A thread-scoped todo panel is rendered above the composer, shows the current todo when collapsed, expands on click, and collapses on outside click.
- Todo styling samples the ChatGPT composer surface/text colors so the widget follows the active ChatGPT appearance.
- `//query` provides Local System skill search while the query stays in the ChatGPT composer. The picker does not steal focus; Up/Down/Enter navigate and select.
- `@@query` provides fuzzy local-file search across the current workspace first, then other authorized Local System roots. Selecting a result fetches it over the loopback bridge and attaches it to ChatGPT as a native browser `File`.
- File attachment uses a drop-only handoff to avoid leaving ChatGPT's global "Drop files here" overlay stuck open.
- Single `/` integration was intentionally removed after proving unreliable; ChatGPT owns its native `/` behavior completely.

## Security boundaries

- The bridge remains loopback-only.
- File/image resolution is restricted to Local System-authorized roots and the relevant conversation scratch scope.
- Local file delivery uses opaque short-lived tickets rather than exposing filesystem paths in fetch URLs.
- File search and skill lookup are thread-aware through the browser-thread binding registry.

## Validation at checkpoint

- ESLint passes for the project.
- Extension scripts pass `node --check`.
- Focused local-image and browser-thread/todo integration tests pass.
- The user has manually confirmed inline images, todos, skills, and local-file attachment in the real ChatGPT UI.

## Explicitly not included

- `todo.md` has unrelated pre-existing user edits and is intentionally excluded from this checkpoint commit.
- Multi-annotation support is the next feature and begins after this checkpoint.
