# Local System website

Static marketing site for the open-source project. No framework or build step is required.

## Preview locally

From the repository root:

```bash
python3 -m http.server 4173 -d website
```

Then open <http://127.0.0.1:4173/>.

The site intentionally uses only HTML, CSS, small native JavaScript, and system font stacks. It does not depend on external analytics, font CDNs, or a client-side framework.

## Product playground

The hero's `ls -la` listing is interactive: type a filter, use Up/Down arrows, press Enter, or click an entry to open its corresponding example. With no user interaction it cycles a highlight; reduced-motion preferences disable that animation.

The sample ChatGPT/Local System panel has five scripted scenarios: command approval, file preview/annotation, file and skill composer attachments, cancellable task progress, and the fixed 11-tool catalogue. It accepts visitor prompts to select and demonstrate supported workflows, but **does not run commands, contact ChatGPT, read local files, or send prompts to any server**. All demo data is hardcoded in `playground.js` and marked as simulated in the UI.

Keep this trust boundary intact if adding features. A real connected-product demo would require a separately designed authentication and sandbox model; never silently turn the public marketing site into a remotely exposed local MCP client.
