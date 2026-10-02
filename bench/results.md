# Benchmark: kay, SolidJS and Svelte

- AMD Ryzen 5 7600 6-Core Processor, 12 threads
- Bun 1.4.3, Chromium 151.0.7922.34 headless
- kay on solid-js 2.0.0-rc.13, solid-js 1.9.15, svelte 5.57.1
- run on 2026-10-02

Every app renders the same markup from the same data behind the same Elysia server, checked before measuring, table rows included. Bold is the best of a row, the factor how far a value is from it. Reproduce with `bun run bench`.

What differs by design:

- Solid and Svelte hydrate the whole page, so their HTML carries the page data as JSON and their one bundle holds both pages' components. kay hydrates its islands only and ships one chunk per island, fetched after its entry and shared chunk.
- Each table is written the way its framework's js-framework-benchmark entry is: Solid keeps a signal per label and selects rows with `createSelector`, Svelte keeps a `$state` label per row, kay replaces rows immutably under a keyed `for` and has no selector primitive, so selecting re-checks every row.

## Server rendering

The products page (layout, 500 products, one counter) rendered in-process through the app's request handler, measured by mitata.

|  | kay | solid | svelte |
| --- | --- | --- | --- |
| renders/s | 1260 (2.92x) | 1700 (2.16x) | **3674** |
| mean (ms) | 0.8 (2.92x) | 0.6 (2.16x) | **0.3** |
| p50 (ms) | 0.7 (2.92x) | 0.5 (2.14x) | **0.2** |
| p99 (ms) | 1.5 (1.84x) | 1.6 (1.98x) | **0.8** |

## Products page in Chromium

Medians of fresh loads with an empty cache: Chromium's main-thread time up to network idle, hydration in script and the first render in style and layout. DOMContentLoaded is left out: it swings between about 25 and 70 ms across identical loads of the same app.

|  | kay | solid | svelte |
| --- | --- | --- | --- |
| JS shipped (gzip) | 26.0 KB (3.26x) | **8.0 KB** | 21.8 KB (2.73x) |
| JS shipped (raw) | 68.4 KB (3.37x) | **20.3 KB** | 57.6 KB (2.84x) |
| JS files | 4 | 1 | 1 |
| HTML (gzip) | **8.2 KB** | 21.6 KB (2.62x) | 15.6 KB (1.90x) |
| HTML (raw) | **93.0 KB** | 171.8 KB (1.85x) | 138.6 KB (1.49x) |
| script (ms) | **1.4** | 12.8 (8.96x) | 15.9 (11.10x) |
| style (ms) | 6.5 (1.02x) | 6.5 (1.03x) | **6.3** |
| layout (ms) | 31.5 (1.01x) | 32.1 (1.02x) | **31.3** |
| JS heap | **1268.3 KB** | 2986.0 KB (2.35x) | 3126.1 KB (2.46x) |

## Table page in Chromium

|  | kay | solid | svelte |
| --- | --- | --- | --- |
| JS shipped (gzip) | 27.0 KB (3.38x) | **8.0 KB** | 21.8 KB (2.73x) |
| JS shipped (raw) | 70.5 KB (3.47x) | **20.3 KB** | 57.6 KB (2.84x) |
| JS files | 4 | 1 | 1 |
| HTML (gzip) | 0.7 KB (1.56x) | 0.7 KB (1.58x) | **0.4 KB** |
| HTML (raw) | 1.2 KB (1.43x) | 1.3 KB (1.49x) | **0.9 KB** |
| script (ms) | **2.2** | 2.7 (1.22x) | 4.6 (2.08x) |
| style (ms) | 0.2 (1.08x) | 0.2 (1.03x) | **0.2** |
| layout (ms) | 2.7 (1.00x) | **2.7** | 2.8 (1.04x) |
| JS heap | 1686.2 KB (1.08x) | **1559.3 KB** | 1591.7 KB (1.02x) |

## Table operations

The js-framework-benchmark keyed operations, median ms over fresh pages: from the click until the DOM holds the result and is laid out, paint excluded. Every framework waits the same one task after the click before the result is checked.

| operation | kay | solid | svelte |
| --- | --- | --- | --- |
| create 1,000 rows | 37.8 (1.08x) | **34.9** | 36.1 (1.03x) |
| replace 1,000 rows | 35.9 (1.05x) | **34.3** | 35.5 (1.03x) |
| update every 10th row | 4.9 (1.46x) | 3.5 (1.03x) | **3.4** |
| select row | 1.8 (3.60x) | **0.5** | 1.4 (2.70x) |
| swap rows | 3.9 (1.48x) | **2.6** | 2.7 (1.04x) |
| remove row | 5.5 (2.29x) | **2.4** | 2.9 (1.19x) |
| create 10,000 rows | 308 (1.10x) | **279** | 280 (1.00x) |
| append 1,000 rows | 34.4 (1.06x) | 32.7 (1.01x) | **32.3** |
| clear 1,000 rows | 4.2 (1.20x) | **3.5** | 4.1 (1.17x) |
