# Benchmark: kay, SolidJS and Svelte

- AMD Ryzen 5 7600 6-Core Processor, 12 threads
- Bun 1.4.3, Chromium 151.0.7922.34 headless
- kay on solid-js 2.0.0-rc.13, solid-js 1.9.15, svelte 5.57.1
- run on 2026-10-02

Every app renders the same markup from the same data behind the same Elysia server, checked before measuring. Solid and Svelte hydrate the whole page from serialized data; kay hydrates its islands only. Bold is the best of a row, the factor how far a value is from it. Reproduce with `bun run bench`.

## Server rendering

The products page (layout, 500 products, one counter) rendered in-process through the app's request handler, measured by mitata.

|  | kay | solid | svelte |
| --- | --- | --- | --- |
| renders/s | 1223 (3.01x) | 1723 (2.14x) | **3683** |
| mean (ms) | 0.8 (3.01x) | 0.6 (2.14x) | **0.3** |
| p50 (ms) | 0.7 (2.97x) | 0.5 (2.11x) | **0.2** |
| p99 (ms) | 1.6 (2.01x) | 1.5 (1.92x) | **0.8** |

## Products page in Chromium

Medians of fresh loads with an empty cache. Script time is Chromium's main-thread JavaScript time up to network idle, hydration included.

|  | kay | solid | svelte |
| --- | --- | --- | --- |
| JS shipped (gzip) | 26.0 KB (3.26x) | **8.0 KB** | 21.8 KB (2.73x) |
| JS shipped (raw) | 68.4 KB (3.37x) | **20.3 KB** | 57.6 KB (2.84x) |
| JS files | 4 | 1 | 1 |
| HTML (gzip) | **8.2 KB** | 21.6 KB (2.62x) | 15.6 KB (1.90x) |
| HTML (raw) | **93.0 KB** | 171.8 KB (1.85x) | 138.6 KB (1.49x) |
| DOMContentLoaded (ms) | 54.5 (2.04x) | **26.8** | 65.1 (2.43x) |
| load (ms) | 54.6 (1.63x) | **33.5** | 65.2 (1.94x) |
| script time (ms) | **1.4** | 11.8 (8.30x) | 15.0 (10.56x) |
| JS heap | **1335.2 KB** | 3050.3 KB (2.28x) | 3204.1 KB (2.40x) |

## Table page in Chromium

|  | kay | solid | svelte |
| --- | --- | --- | --- |
| JS shipped (gzip) | 27.0 KB (3.38x) | **8.0 KB** | 21.8 KB (2.73x) |
| JS shipped (raw) | 70.5 KB (3.47x) | **20.3 KB** | 57.6 KB (2.84x) |
| JS files | 4 | 1 | 1 |
| HTML (gzip) | 0.7 KB (1.56x) | 0.7 KB (1.58x) | **0.4 KB** |
| HTML (raw) | 1.2 KB (1.43x) | 1.3 KB (1.49x) | **0.9 KB** |
| DOMContentLoaded (ms) | 13.9 (1.16x) | **12.0** | 14.1 (1.18x) |
| load (ms) | 14.0 (1.16x) | **12.1** | 14.1 (1.17x) |
| script time (ms) | **2.2** | 2.7 (1.26x) | 4.7 (2.16x) |
| JS heap | 1748.8 KB (1.07x) | **1633.9 KB** | 1664.2 KB (1.02x) |

## Table operations

The js-framework-benchmark keyed operations, median ms over fresh pages: from the click until the DOM holds the result and is laid out, paint excluded.

| operation | kay | solid | svelte |
| --- | --- | --- | --- |
| create 1,000 rows | 38.1 (1.22x) | **31.2** | 36.7 (1.18x) |
| replace 1,000 rows | 37.3 (1.24x) | **30.1** | 35.8 (1.19x) |
| update every 10th row | 5.1 (1.55x) | **3.3** | 3.8 (1.18x) |
| select row | 1.9 (6.33x) | **0.3** | 1.4 (4.83x) |
| swap rows | 3.9 (1.70x) | **2.3** | 2.6 (1.11x) |
| remove row | 5.8 (2.50x) | **2.3** | 2.8 (1.22x) |
| create 10,000 rows | 310 (1.23x) | **253** | 272 (1.08x) |
| append 1,000 rows | 34.0 (1.17x) | **28.9** | 32.5 (1.12x) |
| clear 1,000 rows | 4.3 (1.42x) | **3.0** | 4.3 (1.43x) |
