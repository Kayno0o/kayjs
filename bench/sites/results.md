# Benchmark: the sites before and after kay

- AMD Ryzen 5 7600 6-Core Processor, 12 threads
- Bun 1.4.2, Chromium 151.0.7922.34 headless, nginx/1.30.5
- cromignon24: Astro at fd11fb0, kay 0.11.0 at 57c7cc4
- jb-peinture: Astro at 6b8c6e5, kay 0.11.0 at cd5f496
- run on 2026-10-05

cromignon24 and jb-peinture as they last ran on Astro, then on kay, each built and served as it deploys: Astro's standalone server under Bun, kay's one executable, both behind an nginx set up as production's (HTTP/2 over TLS, brotli and gzip at level 6). kay is the version each site pins, not this checkout. Reproduce with `bun run bench:sites`, the site repositories beside this one, given nginx with the brotli module (`NGINX_MODULES` if not under /usr/lib/nginx/modules), openssl, playwright-core's Chromium, and cloc for the line counts.

## What a page downloads

Average over every page: text as brotli at quality 11 sends it, images as served at each viewport (desktop 1280 px at 1x, phone 390 px at 3x), and the fonts the stylesheets can load for Latin text.

|  | cromignon24 astro | cromignon24 kay | jb-peinture astro | jb-peinture kay |
| --- | --- | --- | --- | --- |
| HTML | 5.1 KB | 5.0 KB | 6.8 KB | 6.8 KB |
| CSS | 35.2 KB | 5.4 KB | 9.3 KB | 7.0 KB |
| JS | 4.8 KB | 16.3 KB | 0.0 KB | 16.7 KB |
| JS files | 1.0 | 5.2 | 0.0 | 8.1 |
| images, desktop | 142.5 KB | 94.0 KB | 160.8 KB | 63.6 KB |
| images, phone | 142.5 KB | 289.4 KB | 185.3 KB | 206.9 KB |
| fonts | 109.5 KB | 109.5 KB | 35.2 KB | 106.6 KB |

## In a browser

Every page loaded cold, 5 times in a fresh context, medians averaged over the pages, with Lighthouse's throttling: a phone on slow 4G with a 4x slower CPU, and a desktop on cable. Total blocking time counts long tasks from the first paint on.

|  | cromignon24 astro | cromignon24 kay | jb-peinture astro | jb-peinture kay |
| --- | --- | --- | --- | --- |
| mobile first paint (ms) | 1500 | 1543 | 1291 | 1590 |
| mobile largest paint (ms) | 2737 | 1939 | 1295 | 1615 |
| mobile blocking time (ms) | 0.0 | 0.0 | 0.0 | 0.0 |
| mobile layout shift | 0.006 | 0.000 | 0.002 | 0.000 |
| mobile load (ms) | 3067 | 3057 | 2401 | 2898 |
| mobile transferred | 255.8 KB | 305.3 KB | 126.1 KB | 214.3 KB |
| mobile requests | 10.1 | 15.7 | 6.3 | 17.7 |
| desktop first paint (ms) | 174 | 214 | 166 | 224 |
| desktop largest paint (ms) | 349 | 263 | 211 | 277 |
| desktop blocking time (ms) | 0.0 | 0.0 | 0.0 | 0.0 |
| desktop layout shift | 0.007 | 0.000 | 0.001 | 0.000 |
| desktop load (ms) | 347 | 240 | 296 | 406 |
| desktop transferred | 266.6 KB | 199.7 KB | 207.6 KB | 311.8 KB |
| desktop requests | 11.1 | 15.3 | 7.6 | 19.0 |

## Server

Cold start is from spawning the server to its first 200 on the home page, median of 7. Under load, 32 clients request one URL through nginx for 5 s over keepalive HTTP/1.1, accepting brotli; CPU is per request, of the site's server and of nginx, which compresses what the server sent uncompressed. The client is Bun's fetch, which tops out near 40,000 requests a second.

|  | cromignon24 astro | cromignon24 kay | jb-peinture astro | jb-peinture kay |
| --- | --- | --- | --- | --- |
| cold start | 105 ms | 71.0 ms | 53.8 ms | 64.2 ms |
| memory once started | 114 MB | 67 MB | 67 MB | 61 MB |
| memory after load (peak) | 255 MB (308 MB) | 129 MB (141 MB) | 121 MB (144 MB) | 89 MB (96 MB) |

|  | URL | req/s | p50 (ms) | p99 (ms) | server CPU (µs/req) | nginx CPU (µs/req) |
| --- | --- | --- | --- | --- | --- | --- |
| cromignon24 astro | `/` | 2146 | 11.7 | 27.0 | 552 | 1474 |
| cromignon24 astro | `/hotel-felin` | 12066 | 1.5 | 9.1 | 100 | 473 |
| cromignon24 astro | `/_astro/index.CA4QUJZR.css` | 3116 | 5.8 | 48.0 | 177 | 2600 |
| cromignon24 kay | `/` | 3541 | 5.4 | 26.5 | 292 | 1664 |
| cromignon24 kay | `/hotel-felin` | 40809 | 0.7 | 2.0 | 22 | 21 |
| cromignon24 kay | `/_kay/_layout-qpxskh48.css` | 45409 | 0.6 | 1.9 | 23 | 21 |
| jb-peinture astro | `/` | 5811 | 2.6 | 25.0 | 153 | 1134 |
| jb-peinture astro | `/peinture` | 10917 | 1.5 | 10.4 | 99 | 542 |
| jb-peinture astro | `/_astro/default.fuv9R-in.css` | 7448 | 2.1 | 17.3 | 116 | 883 |
| jb-peinture kay | `/` | 41416 | 0.7 | 2.0 | 23 | 23 |
| jb-peinture kay | `/peinture` | 41569 | 0.7 | 2.0 | 22 | 21 |
| jb-peinture kay | `/_kay/_layout-48hf4jz7.css` | 41587 | 0.7 | 2.0 | 27 | 21 |

## Build and code

Clean builds, median of 3. `kay build` runs `kay check` first, which `astro build` has no equivalent of. Lines are cloc's code lines of `src` and the config files.

|  | command | wall (s) | CPU (s) | peak memory |
| --- | --- | --- | --- | --- |
| cromignon24 astro | `astro build` | 2.38 | 5.7 | 1105 MB |
| cromignon24 kay | `kay build` | 2.75 | 9.8 | 607 MB |
| cromignon24 kay | `kay build --no-check` | 2.29 | 8.4 | 584 MB |
| jb-peinture astro | `astro build` | 1.66 | 6.5 | 1156 MB |
| jb-peinture kay | `kay build` | 1.38 | 5.9 | 493 MB |
| jb-peinture kay | `kay build --no-check` | 0.96 | 4.8 | 472 MB |

|  | cromignon24 astro | cromignon24 kay | jb-peinture astro | jb-peinture kay |
| --- | --- | --- | --- | --- |
| lines of code | 1892 | 1364 | 1935 | 1244 |
| lines of tests | 0 | 467 | 0 | 252 |
| deployed | 231 MB (dist and production node_modules) | 95 MB (one executable) | 301 MB (dist and production node_modules) | 87 MB (one executable) |
