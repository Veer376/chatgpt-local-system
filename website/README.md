# Local System website

Static marketing site for the open-source project. No framework or build step is required.

## Preview locally

From the repository root:

```bash
python3 -m http.server 4173 -d website
```

Then open <http://127.0.0.1:4173/>.

The site intentionally uses only HTML, CSS, small native JavaScript, and system font stacks. It does not depend on external analytics, font CDNs, or a client-side framework.
