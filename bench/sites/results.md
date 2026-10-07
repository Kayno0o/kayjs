# Benchmark: the sites before and after kay

- AMD Ryzen 5 7600 6-Core Processor, 12 threads
- Bun 1.4.2, Chromium 151.0.7922.34 headless, nginx/1.30.5
- cromignon24: Astro at fd11fb0, kay 1.4.0 at f3ad1e2
- jb-peinture: Astro at 6b8c6e5, kay 1.4.0 at a9f1d4c
- run on 2026-10-07

cromignon24 and jb-peinture as they last ran on Astro, then on kay, each built and served as it deploys: Astro's standalone server under Bun, kay's one executable, both behind an nginx set up as production's (HTTP/2 over TLS, brotli and gzip at level 6). kay is the version each site pins, not this checkout. Reproduce with `bun run bench:sites`, the site repositories beside this one, given nginx with the brotli module (`NGINX_MODULES` if not under /usr/lib/nginx/modules), openssl, playwright-core's Chromium, and cloc for the line counts.

## What a page downloads

Average over every page: text as brotli at quality 11 sends it, images as served at each viewport (desktop 1280 px at 1x, phone 390 px at 3x), and the fonts the stylesheets can load for Latin text.

|  | cromignon24 astro | cromignon24 kay | jb-peinture astro | jb-peinture kay |
| --- | --- | --- | --- | --- |
| HTML | 5.1 KB | 5.0 KB | 6.8 KB | 6.7 KB |
| CSS | 35.2 KB | 5.5 KB | 9.3 KB | 7.0 KB |
| JS | 4.8 KB | 9.1 KB | 0.0 KB | 9.4 KB |
| JS files | 1.0 | 2.0 | 0.0 | 5.0 |
| images, desktop | 142.5 KB | 94.0 KB | 160.8 KB | 63.6 KB |
| images, phone | 142.5 KB | 199.7 KB | 185.3 KB | 185.5 KB |
| fonts | 109.5 KB | 109.5 KB | 35.2 KB | 106.6 KB |

## In a browser

Every page loaded cold, 5 times in a fresh context, medians averaged over the pages, with Lighthouse's throttling: a phone on slow 4G with a 4x slower CPU, and a desktop on cable. Total blocking time counts long tasks from the first paint on.

|  | cromignon24 astro | cromignon24 kay | jb-peinture astro | jb-peinture kay |
| --- | --- | --- | --- | --- |
| mobile first paint (ms) | 1497 | 1353 | 1285 | 1361 |
| mobile largest paint (ms) | 2734 | 1754 | 1292 | 1373 |
| mobile blocking time (ms) | 0.0 | 0.0 | 0.0 | 0.0 |
| mobile layout shift | 0.006 | 0.006 | 0.002 | 0.018 |
| mobile load (ms) | 3065 | 3070 | 2393 | 2903 |
| mobile transferred | 255.8 KB | 281.4 KB | 126.1 KB | 206.3 KB |
| mobile requests | 10.1 | 11.8 | 6.3 | 14.7 |
| desktop first paint (ms) | 172 | 155 | 165 | 171 |
| desktop largest paint (ms) | 351 | 260 | 210 | 250 |
| desktop blocking time (ms) | 0.0 | 0.0 | 0.0 | 0.0 |
| desktop layout shift | 0.007 | 0.001 | 0.001 | 0.001 |
| desktop load (ms) | 347 | 265 | 296 | 399 |
| desktop transferred | 266.6 KB | 175.8 KB | 207.6 KB | 303.8 KB |
| desktop requests | 11.1 | 11.4 | 7.6 | 16.0 |

## Server

Cold start is from spawning the server to its first 200 on the home page, median of 7. Under load, 32 clients request one URL through nginx for 5 s over keepalive HTTP/1.1, accepting brotli; CPU is per request, of the site's server and of nginx, which compresses what the server sent uncompressed. The client is Bun's fetch, which tops out near 40,000 requests a second.

|  | cromignon24 astro | cromignon24 kay | jb-peinture astro | jb-peinture kay |
| --- | --- | --- | --- | --- |
| cold start | 110 ms | 73.0 ms | 52.1 ms | 66.5 ms |
| memory once started | 115 MB | 68 MB | 66 MB | 62 MB |
| memory after load (peak) | 283 MB (311 MB) | 135 MB (151 MB) | 134 MB (149 MB) | 91 MB (99 MB) |

|  | URL | req/s | p50 (ms) | p99 (ms) | server CPU (µs/req) | nginx CPU (µs/req) |
| --- | --- | --- | --- | --- | --- | --- |
| cromignon24 astro | `/` | 2224 | 11.6 | 25.1 | 533 | 1421 |
| cromignon24 astro | `/hotel-felin` | 12523 | 1.6 | 8.7 | 94 | 472 |
| cromignon24 astro | `/_astro/index.CA4QUJZR.css` | 3254 | 6.1 | 43.6 | 173 | 2549 |
| cromignon24 kay | `/` | 3153 | 6.3 | 25.1 | 337 | 1578 |
| cromignon24 kay | `/hotel-felin` | 40486 | 0.7 | 2.0 | 22 | 20 |
| cromignon24 kay | `/_kay/_layout-jwvwphka.css` | 45513 | 0.6 | 1.9 | 22 | 20 |
| jb-peinture astro | `/` | 6068 | 2.4 | 23.0 | 154 | 1118 |
| jb-peinture astro | `/peinture` | 11376 | 1.4 | 10.1 | 96 | 541 |
| jb-peinture astro | `/_astro/default.fuv9R-in.css` | 7848 | 1.9 | 17.6 | 109 | 879 |
| jb-peinture kay | `/` | 40534 | 0.7 | 2.1 | 23 | 22 |
| jb-peinture kay | `/peinture` | 41071 | 0.7 | 2.0 | 22 | 21 |
| jb-peinture kay | `/_kay/_layout-cdhdykcp.css` | 41841 | 0.7 | 1.9 | 27 | 21 |

## Build and code

Clean builds, median of 3. `kay build` runs `kay check` first, which `astro build` has no equivalent of. Lines are cloc's code lines of `src` and the config files.

|  | command | wall (s) | CPU (s) | peak memory |
| --- | --- | --- | --- | --- |
| cromignon24 astro | `astro build` | 1.94 | 5.1 | 1099 MB |
| cromignon24 kay | `kay build` | 2.14 | 9.2 | 608 MB |
| cromignon24 kay | `kay build --no-check` | 2.04 | 7.8 | 587 MB |
| jb-peinture astro | `astro build` | 1.48 | 6.2 | 1222 MB |
| jb-peinture kay | `kay build` | 1.30 | 6.3 | 438 MB |
| jb-peinture kay | `kay build --no-check` | 0.92 | 4.7 | 445 MB |

|  | cromignon24 astro | cromignon24 kay | jb-peinture astro | jb-peinture kay |
| --- | --- | --- | --- | --- |
| lines of code | 1892 | 1367 | 1935 | 1245 |
| lines of tests | 0 | 484 | 0 | 260 |
| deployed | 231 MB (dist and production node_modules) | 95 MB (one executable) | 301 MB (dist and production node_modules) | 87 MB (one executable) |
