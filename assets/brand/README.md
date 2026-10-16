# Local System brand system

**Concept:** a geometric, custom-drawn lowercase `l` and `s`, using the command-name shorthand for **list directory contents**. The vertical `l` is phosphor green, the routed `s` is warm white. These paths are custom SVG shapes, **not typeface outlines**, generated imagery, stock icons or third-party logos.

## Canonical sources

- `mark.svg` — original square symbol, font-independent; canonical identity for all raster exports.
- `wordmark.svg` — mark + `LOCAL SYSTEM` for dark backgrounds; its lettering uses the system sans fallback stack.
- `readme-hero.svg` — branded GitHub README header with terminal listing.
- `social-preview.svg` / `social-preview.png` — social preview artwork, 1200 × 630.
- `../../docs/assets/features/feature-map.svg` — feature artwork in the same visual language.
- `../../website/favicon.svg`, `../../website/apple-touch-icon.png`, `../../website/social-preview.png`, and `../../extensions/local-system/icons/local-system-{16,32,48,128}.png` are derivative outputs.

All artwork is locally authored in the repository by `scripts/generate-brand-assets.mjs`. There are no external art assets to attribute or license separately. It is released under the repository's MIT License.

## Usage

| Role | Value |
| --- | --- |
| Primary canvas | `#050706` |
| Mark canvas | `#080B08` |
| Phosphor signal | `#D4FF52` |
| Main foreground | `#F2F5E9` |
| Secondary text | `#929B8F` |
| Borders | `#283326` |
| Secondary accent | `#7CFFAD` |

Use the full-color mark at **16px or larger**. Retain at least **12.5% of its width** as clear space around the square silhouette. Do not stretch, rotate, recolor individual strokes, add drop shadows, or replace the custom letterforms with typed `ls`. On a light canvas, use the dark square version; do not place the green/white paths directly against white.

**Accessibility:** the symbol is decorative next to the adjacent visible name; supply an empty `alt` attribute there. For standalone logos, use descriptive alt text such as “Local System logo.” The original SVG includes an accessible title/description. Motion is not part of the logo. Main text and interactive colors should continue to be checked against their immediate background.

## Rebuild icons

Run `node scripts/generate-brand-assets.mjs` from a checkout with `playwright-core` installed and a Chrome/Chromium binary. Set `CHROME_PATH` if the browser is not at a standard platform location. The script writes all derivative vector and raster files from one design definition; it does not contact external websites.

To set a GitHub repository *social preview*, upload `social-preview.png` under **Settings → General → Social preview**. Merely committing the image does not change GitHub's repository card. The public website, however, references its version through the Open Graph tags.
