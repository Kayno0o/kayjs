# Kay v2 Docs

100% static documentation site built with Kay v2 itself (`@kayjs/ui` Orbit grammar, `@kayjs/content`, `@kayjs/images`, `@kayjs/seo`, `@kayjs/icons`).

## Local development & static build

```sh
cd docs
bun install
bun run dev     # Fast incremental rebuilds + live reload on http://localhost:3000
bun run build   # Static export + .br/.gz sidecars into docs/dist/static
```

## Docker deployment (Caddy precompressed static server)

Build and run from the **repository root**:

```sh
docker compose -f docs/compose.yaml up -d --build
```

Environment variables (optional):
- `SITE_URL` — canonical URL embedded in sitemap, OpenGraph tags, and share cards (default: `https://v2.kayjs.kaynooo.fr`).
- `DOCS_PORT` — loopback host port (default: `3650`, leaving v1's `3649` untouched when running side-by-side).

Point your host reverse proxy (nginx / Caddy) at `http://127.0.0.1:3650`. Caddy serves precompressed `.br` and `.gz` sidecars directly from disk with immutable caching on `/_kay/*` and `/fonts/*`, and renders `/404.html` on missing paths.
