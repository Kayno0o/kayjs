# Benchmark: the sites before and after kay

- AMD Ryzen 5 7600 6-Core Processor, 12 threads
- Bun 1.4.2, Chromium 151.0.7922.34 headless, nginx/1.30.5
- cromignon24: kay 1.16.6 at 497066f
- jb-peinture: kay 1.16.6 at ef8a894
- run on 2026-10-09

cromignon24 and jb-peinture as they last ran on Astro, then on kay, each built and served as it deploys: Astro's standalone server under Bun, kay's one executable, both behind an nginx set up as production's (HTTP/2 over TLS, brotli and gzip at level 6). kay is the version each site pins, not this checkout. Reproduce with `bun run bench:sites`, the site repositories beside this one, given nginx with the brotli module (`NGINX_MODULES` if not under /usr/lib/nginx/modules), openssl, playwright-core's Chromium, and cloc for the line counts.

## What a page downloads

Average over every page: text as brotli at quality 11 sends it, images as served at each viewport (desktop 1280 px at 1x, phone 390 px at 3x), and the fonts the stylesheets can load for Latin text.

Inline `<script>` bodies count as JS, weighed as what they add to the page's brotli (kayjs #158). These figures predate that change, so their HTML and JS rows were corrected from the cached builds of the same commits. cromignon24's home page is not prerendered, so its share is the average of its other pages'.

|  | cromignon24 kay | jb-peinture kay |
| --- | --- | --- |
| HTML | 5.1 KB | 6.8 KB |
| CSS | 5.3 KB | 6.8 KB |
| JS | 10.1 KB | 10.4 KB |
| JS files | 2.0 | 5.0 |
| images, desktop | 55.2 KB | 36.4 KB |
| images, phone | 114.5 KB | 105.2 KB |
| fonts | 109.5 KB | 106.6 KB |

## In a browser

Every page loaded cold, 5 times in a fresh context, medians averaged over the pages, with Lighthouse's throttling: a phone on slow 4G with a 4x slower CPU, and a desktop on cable. Total blocking time counts long tasks from the first paint on.

|  | cromignon24 kay | jb-peinture kay |
| --- | --- | --- |
| mobile first paint (ms) | 1364 | 1369 |
| mobile largest paint (ms) | 1758 | 1371 |
| mobile blocking time (ms) | 0.0 | 0.0 |
| mobile layout shift | 0.006 | 0.018 |
| mobile load (ms) | 2702 | 2698 |
| mobile transferred | 196.8 KB | 165.6 KB |
| mobile requests | 10.8 | 13.7 |
| desktop first paint (ms) | 166 | 188 |
| desktop largest paint (ms) | 268 | 254 |
| desktop blocking time (ms) | 0.0 | 0.0 |
| desktop layout shift | 0.001 | 0.001 |
| desktop load (ms) | 257 | 353 |
| desktop transferred | 137.5 KB | 225.7 KB |
| desktop requests | 10.4 | 15.0 |

## Server

Cold start is from spawning the server to its first 200 on the home page, median of 7. Under load, 32 clients request one URL through nginx for 5 s over keepalive HTTP/1.1, accepting brotli; CPU is per request, of the site's server and of nginx, which compresses what the server sent uncompressed. The client is Bun's fetch, which tops out near 40,000 requests a second.

|  | cromignon24 kay | jb-peinture kay |
| --- | --- | --- |
| cold start | 28.6 ms | 23.3 ms |
| memory once started | 68 MB | 61 MB |
| memory after load (peak) | 134 MB (146 MB) | 95 MB (107 MB) |

|  | URL | req/s | p50 (ms) | p99 (ms) | server CPU (µs/req) | nginx CPU (µs/req) |
| --- | --- | --- | --- | --- | --- | --- |
| cromignon24 kay | `/` | 3345 | 6.1 | 23.6 | 321 | 908 |
| cromignon24 kay | `/hotel-felin` | 39090 | 0.7 | 2.1 | 22 | 21 |
| cromignon24 kay | `/_kay/_layout-sjxtq4vb.css` | 56131 | 0.5 | 1.6 | 14 | 20 |
| jb-peinture kay | `/` | 40051 | 0.7 | 2.1 | 23 | 22 |
| jb-peinture kay | `/peinture` | 39118 | 0.7 | 2.0 | 23 | 22 |
| jb-peinture kay | `/_kay/_layout-j8sny4hd.css` | 54849 | 0.5 | 1.7 | 14 | 20 |

## Build and code

Clean builds, median of 3. `kay build` runs `kay check` first, which `astro build` has no equivalent of. Lines are cloc's code lines of `src` and the config files.

|  | command | wall (s) | CPU (s) | peak memory |
| --- | --- | --- | --- | --- |
| cromignon24 kay | `kay build` | 12.59 | 53.0 | 1825 MB |
| cromignon24 kay | `kay build --no-check` | 11.64 | 47.1 | 1837 MB |
| jb-peinture kay | `kay build` | 7.30 | 32.3 | 1146 MB |
| jb-peinture kay | `kay build --no-check` | 7.10 | 29.7 | 1108 MB |

|  | cromignon24 kay | jb-peinture kay |
| --- | --- | --- |
| lines of code | 1282 | 1219 |
| lines of tests | 355 | 154 |
| deployed | 109 MB (one executable) | 98 MB (one executable) |
