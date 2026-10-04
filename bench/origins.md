# Where kay's bytes and time go

- AMD Ryzen 5 7600 6-Core Processor, 12 threads
- Bun 1.4.2, Chromium 151.0.7922.34 headless
- kay 2173ae9 with uncommitted changes under src/
- run on 2026-10-04

What kay costs, by where it comes from. kay is kay's runtime and the entry it generates; app is the bench app's components as kay compiled them and its shared data. Reproduce with `bun run bench:origins`; the cross-framework numbers are in results.md.

## JS shipped

The client kay builds for production, every byte attributed through its source maps. Raw bytes add up to the files' size, the comments a source map build adds left out; "gzip saved" is how much smaller the gzipped files get without that origin's bytes, so it does not add up to the total.

|  | products raw | products gzip saved | table raw | table gzip saved |
| --- | --- | --- | --- | --- |
| kay | 11.7 KB (67%) | 4.9 KB (65%) | 11.7 KB (60%) | 4.9 KB (58%) |
| app | 0.3 KB (2%) | 0.2 KB (3%) | 2.4 KB (12%) | 1.1 KB (13%) |
| devalue | 4.6 KB (26%) | 1.7 KB (22%) | 4.6 KB (23%) | 1.7 KB (20%) |
| bundler | 0.9 KB (5%) | 0.5 KB (7%) | 0.9 KB (5%) | 0.5 KB (6%) |
| **total** | 17.4 KB | 7.5 KB gzip | 19.6 KB | 8.5 KB gzip |

## Server rendering

Microseconds per render of the products page, from Bun's CPU profiler over warm in-process renders. A native function, such as a string method, counts for the JavaScript that called it.

|  | µs per render |
| --- | --- |
| kay | 190 (68%) |
| app | 70 (25%) |
| elysia | 15 (5%) |
| engine | 5 (2%) |
| devalue | 2 (1%) |
| **total** | 280 |

## Page loads in Chromium

Main-thread milliseconds per fresh load up to network idle, from Chromium's CPU profiler sampling every 50 µs, means of 10 loads. A DOM call counts for the JavaScript that made it, so creating nodes counts for the code that asked for them. engine is Chromium's own work outside any script: parsing, style, layout. inline scripts are the page's inline scripts.

|  | products | table |
| --- | --- | --- |
| kay | 1.0 (2%) | 1.0 (8%) |
| app | 0.2 (0%) | 1.0 (8%) |
| engine | 49.1 (96%) | 9.5 (77%) |
| bundler | 0.4 (1%) | 0.4 (3%) |
| devalue | 0.2 (0%) | 0.2 (2%) |
| GC | 0.1 (0%) | 0.1 (1%) |
| inline scripts | 0.1 (0%) | 0.1 (0%) |
| **total** | 51.0 | 12.3 |

## Table operations in Chromium

The operations of results.md, 10 profiled samples each after 2 warmups, means in ms where results.md gives medians. "measured" is the click-to-DOM time as results.md times it, a little longer with the profiler running; "profiled" the time the profiler saw over the same window. style and layout is the work the timing forces with `offsetHeight` once the DOM holds the result: what Chromium spends laying out the rows, whoever made them.

| operation | measured (ms) | profiled (ms) | kay | app | GC | engine | style and layout | other | kay share |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| create 1,000 rows | 36.3 | 41.5 | 8.0 | 1.7 | 5.0 | 4.6 | 22.2 | 0.0 | **19%** |
| replace 1,000 rows | 29.3 | 33.9 | 7.8 | 1.0 | 0.2 | 4.5 | 20.4 | 0.0 | **23%** |
| update every 10th row | 3.8 | 4.5 | 1.0 | 0.1 | 0.0 | 0.6 | 2.8 | 0.0 | **22%** |
| select row | 0.2 | 0.7 | 0.1 | 0.1 | 0.0 | 0.4 | 0.2 | 0.0 | **9%** |
| swap rows | 2.8 | 3.3 | 0.9 | 0.0 | 0.0 | 0.4 | 2.1 | 0.0 | **26%** |
| remove row | 2.5 | 3.3 | 0.6 | 0.0 | 0.0 | 0.6 | 2.0 | 0.0 | **18%** |
| create 10,000 rows | 257 | 294 | 43.5 | 8.4 | 16.1 | 35.7 | 190 | 0.0 | **15%** |
| append 1,000 rows | 28.1 | 32.7 | 4.4 | 1.4 | 0.1 | 4.5 | 22.3 | 0.0 | **13%** |
| clear 1,000 rows | 3.4 | 3.9 | 3.3 | 0.0 | 0.0 | 0.4 | 0.2 | 0.0 | **84%** |
