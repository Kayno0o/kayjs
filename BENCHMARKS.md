# Kay v1 vs Kay v2 — Real-App Benchmarks

All benchmarks below were run interleaved on the same host (Linux x64, Bun `1.4.5`) against identical databases/content with clean cache handling and recorded host load averages.

---

## 1. Interactive Full-Stack App — `polaris` (`orbit` bookmarks + SQLite + `@kayjs/ui` + `@kayjs/mcp` + `--compile`)

- **Date:** 2026-11-24
- **Base (v1):** `orbit@ad21c7f` (Kay `1.112.2` + Elysia `1.4.31`)
- **After (v2):** `orbit-v2@5b67ddf` on `kayjs@56e0c2c` / `v2.0.0-alpha.7` (no Elysia, native `Bun.serve`)
- **Dataset:** 100 seeded bookmarks across 8 folders in SQLite (`@kaynooo/pg-orm`), compiled standalone binary with `KAY_PROXY_KEY` and `KAY_SECRET` enabled (matching production)
- **Host load average:** `0.74` → `1.10`
- **Issue:** `kaynooo/kayjs#3523`

| Metric | Before (v1 `ad21c7f`) | After (v2 `56e0c2c`) | Delta |
| --- | ---: | ---: | ---: |
| Cold `kay build` wall | 2,796.7 ms | **167.9 ms** | **-94.0% (16.7x)** |
| Cold `kay build` CPU | 7,046.6 ms | **362.1 ms** | **-94.9%** |
| Cold `kay build` Peak RSS | 484.8 MiB | **154.9 MiB** | **-68.0%** |
| Warm `kay build` wall (median of 3) | 1,715.4 ms | **239.1 ms** | **-86.1% (7.2x)** |
| Warm `kay build` CPU (median of 3) | 3,994.1 ms | **460.0 ms** | **-88.5%** |
| Warm `kay build` Peak RSS (median of 3) | 440.6 MiB | **218.2 MiB** | **-50.5%** |
| `kay build --compile` wall | 2,903.8 ms | **465.6 ms** | **-84.0% (6.2x)** |
| `kay build --compile` CPU | 6,342.5 ms | **828.0 ms** | **-86.9%** |
| Standalone binary size | 125.63 MiB | **104.77 MiB** | **-16.6%** |
| Cold boot to first 200 OK (median) | 98.9 ms | **72.5 ms** | **-26.7%** |
| Idle `RssAnon` (median) | 39.4 MiB | **25.6 MiB** | **-35.0%** |
| Idle `RssFile` (median) | 2.7 MiB | **2.7 MiB** | 0.0% |
| Idle `PSS` (median) | 93.5 MiB | **64.7 MiB** | **-30.8%** |
| SSR `GET /` throughput (240 reqs, c=4, gzip) | 406.1 req/s | **773.6 req/s** | **+90.5% (1.90x)** |
| SSR `GET /` server CPU (240 reqs) | 990 ms | **430 ms** | **-56.6%** |
| Home `/` HTML (raw / gzip) | 67.29 KB / 8.33 KB | 80.39 KB / **6.93 KB** | **-16.9% gz** |
| Home `/` Eager JS (files / raw / gzip) | 62 / 218.87 KB / 90.31 KB | **17 / 44.52 KB / 17.92 KB** | **-80.2% gz (5.0x lighter)** |
| Home `/` CSS (files / raw / gzip) | 3 / 128.30 KB / 20.53 KB | 3 / **50.28 KB / 9.29 KB** | **-54.8% gz (2.2x lighter)** |

---

## 2. Static Content Site — `devlog` (`https://log.kaynooo.fr/`, Markdown + Shiki + AVIF/WebP images + `--static`)

- **Date:** 2026-11-24
- **Base (v1):** `devlog@bbe5842` (Kay `1.104`)
- **After (v2):** `devlog@21b7dc3` (Kay `2.0.0-alpha.6`, `@kayjs/content` + `@kayjs/images` + `@kayjs/tailwind` + `@kayjs/seo`)
- **Host load average:** `2.14` → `1.96`

| Metric | Before (v1 `bbe5842`) | After (v2 `21b7dc3`) | Delta |
| --- | ---: | ---: | ---: |
| Cold `--static` build wall | 2,287 ms | **1,665 ms** | **-27.2%** |
| Cold `--static` build CPU | 6,690 ms | **2,565 ms** | **-61.7%** |
| Cold `--static` Peak RSS | 824 MiB | **336 MiB** | **-59.2%** |
| Warm `--static` build wall (median of 5) | 1,054 ms | **741 ms** | **-29.7%** |
| Warm `--static` build CPU (median of 5) | 2,302 ms | **1,333 ms** | **-42.1%** |
| Warm `--static` Peak RSS (median of 5) | 389 MiB | **358 MiB** | **-8.1%** |
| `dist/` raw size (non-sidecar files) | 7.29 MiB (166 files) | **1.93 MiB (95 files)** | **-73.5%** |
| Home `/` HTML (raw / brotli) | 45.7 KB / 8.62 KB | **11.8 KB / 2.85 KB** | **-66.9% br** |
| Home `/` CSS (brotli, cached files) | 0 KB (inlined in HTML) | 7.26 KB (2 files) | Split into cacheable CSS |
| Home `/` JS (brotli) | 147 B (1 script) | **0 B (0 scripts)** | **-100%** |
| Post `/posts/five-frameworks` HTML (raw / br) | 115.0 KB / 12.73 KB | **70.7 KB / 6.05 KB** | **-52.5% br** |
| Post `/posts/five-frameworks` JS (brotli) | 1,236 B (2) | **1,089 B (1)** | **-11.9%** |
| `bun.lock` dependency graph | 407 packages | **101 packages** | **-75.2%** |
| `node_modules` disk footprint | 324.3 MiB | 355.2 MiB | +9.5% *(native prebuilts: `oxc-parser`, `sharp`, `lucide`)* |
