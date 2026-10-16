# Local System brand system

**Concept:** the original website mark: lowercase `ls`—the Unix command shorthand for **list directory contents**—set in dark monospace type on a phosphor-green rounded square. This is intentionally the same small mark that appeared in the website navigation before a separate extension icon was introduced.

## Canonical source

- `../../website/favicon.svg` — **the canonical Local System logo**. The website renders this exact file, and every repository/extension logo derivative is rebuilt from it.
- `mark.svg` — byte-for-byte copy of the website canonical mark for the public brand-kit directory.
- `wordmark.svg` — mark + `LOCAL SYSTEM` for dark backgrounds; its lettering uses the system sans fallback stack.
- `readme-hero.svg` — branded GitHub README header with terminal listing.
- `social-preview.svg` / `social-preview.png` — social preview artwork, 1200 × 630.
- `../../docs/assets/features/feature-map.svg` — feature artwork in the same visual language.
- `../../website/apple-touch-icon.png`, `../../website/social-preview.png`, and `../../extensions/local-system/icons/site-logo-{16,32,48,128}.png` are derivative outputs. The `website-logo-*` and older `local-system-*` files are also regenerated from the same canonical SVG for compatibility; the extension manifest uses the newest `site-logo-*` names specifically to bypass stale Chrome toolbar-icon caching from earlier branding revisions.

All artwork is locally authored in the repository by `scripts/generate-brand-assets.mjs`. There are no external art assets to attribute or license separately. It is released under the repository's MIT License.

## Usage

| Role | Value |
| --- | --- |
| Primary canvas | `#050706` |
| Mark canvas | `#D4FF52` |
| Mark/type foreground | `#081008` |
| Phosphor signal | `#D4FF52` |
| Main foreground | `#F2F5E9` |
| Secondary text | `#929B8F` |
| Borders | `#283326` |
| Secondary accent | `#7CFFAD` |

Use the full-color mark at **16px or larger**. Retain at least **12.5% of its width** as clear space around the square silhouette. Do not stretch, rotate, recolor the `ls`, or substitute another badge shape. The website may apply its subtle phosphor outer glow; extension/GitHub raster icons should remain the clean green square without extra shadow pixels.

**Accessibility:** the symbol is decorative next to the adjacent visible name; supply an empty `alt` attribute there. For standalone logos, use descriptive alt text such as “Local System logo.” The original SVG includes an accessible title/description. Motion is not part of the logo. Main text and interactive colors should continue to be checked against their immediate background.

## Rebuild icons

Run `node scripts/generate-brand-assets.mjs` from a checkout with `playwright-core` installed and a Chrome/Chromium binary. Set `CHROME_PATH` if the browser is not at a standard platform location. The script reads `website/favicon.svg` as the single source of truth and writes every derivative vector/raster from it; it does not contact external websites.

To set a GitHub repository *social preview*, upload `social-preview.png` under **Settings → General → Social preview**. Merely committing the image does not change GitHub's repository card. The public website, however, references its version through the Open Graph tags.
