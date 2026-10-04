# Where kay's bytes and time go

- AMD Ryzen 5 7600 6-Core Processor, 12 threads
- Bun 1.4.2, Chromium 151.0.7922.34 headless
- kay 4a58d6c with uncommitted changes under src/
- run on 2026-10-04

What kay costs, by where it comes from. kay is kay's runtime and the entry it generates; app is the bench app's components as kay compiled them and its shared data. Reproduce with `bun run bench:origins`; the cross-framework numbers are in results.md.

## JS shipped

The client kay builds for production, every byte attributed through its source maps. Raw bytes add up to the files' size, the comments a source map build adds left out; "gzip saved" is how much smaller the gzipped files get without that origin's bytes, so it does not add up to the total.

|  | products raw | products gzip saved | table raw | table gzip saved |
| --- | --- | --- | --- | --- |
| kay | 13.3 KB (92%) | 5.6 KB (86%) | 13.3 KB (80%) | 5.6 KB (75%) |
| app | 0.3 KB (2%) | 0.2 KB (3%) | 2.4 KB (15%) | 1.1 KB (15%) |
| bundler | 0.9 KB (7%) | 0.5 KB (8%) | 1.0 KB (6%) | 0.5 KB (7%) |
| **total** | 14.5 KB | 6.6 KB gzip | 16.7 KB | 7.5 KB gzip |

## Server rendering

Microseconds per render of the products page, from Bun's CPU profiler over warm in-process renders. A native function, such as a string method, counts for the JavaScript that called it.

|  | µs per render |
| --- | --- |
| kay | 185 (68%) |
| app | 67 (25%) |
| elysia | 14 (5%) |
| engine | 6 (2%) |
| devalue | 1 (0%) |
| **total** | 273 |

## Page loads in Chromium

Main-thread milliseconds per fresh load up to network idle, from Chromium's CPU profiler sampling every 50 µs, means of 10 loads. A DOM call counts for the JavaScript that made it, so creating nodes counts for the code that asked for them. engine is Chromium's own work outside any script: parsing, style, layout. inline scripts are the page's inline scripts.

|  | products | table |
| --- | --- | --- |
| kay | 1.4 (3%) | 1.2 (10%) |
| app | 0.1 (0%) | 1.0 (9%) |
| engine | 50.0 (96%) | 9.3 (76%) |
| bundler | 0.5 (1%) | 0.5 (4%) |
| GC | 0.1 (0%) | 0.2 (1%) |
| inline scripts | 0.1 (0%) | 0.1 (1%) |
| **total** | 52.1 | 12.1 |

## Table operations in Chromium

The operations of results.md, 10 profiled samples each after 2 warmups, means in ms where results.md gives medians. "measured" is the click-to-DOM time as results.md times it, a little longer with the profiler running; "profiled" the time the profiler saw over the same window. style and layout is the work the timing forces with `offsetHeight` once the DOM holds the result: what Chromium spends laying out the rows, whoever made them.

| operation | measured (ms) | profiled (ms) | kay | app | GC | engine | style and layout | other | kay share |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| create 1,000 rows | 35.3 | 40.3 | 7.6 | 1.7 | 4.9 | 4.5 | 21.6 | 0.0 | **19%** |
| replace 1,000 rows | 29.8 | 34.5 | 8.1 | 0.9 | 0.1 | 4.5 | 20.9 | 0.0 | **23%** |
| update every 10th row | 3.8 | 4.4 | 0.9 | 0.1 | 0.0 | 0.5 | 2.9 | 0.0 | **21%** |
| select row | 0.2 | 0.7 | 0.1 | 0.1 | 0.0 | 0.3 | 0.3 | 0.0 | **12%** |
| swap rows | 2.6 | 3.2 | 0.8 | 0.0 | 0.0 | 0.5 | 2.0 | 0.0 | **23%** |
| remove row | 2.4 | 2.9 | 0.6 | 0.0 | 0.0 | 0.4 | 2.0 | 0.0 | **20%** |
| create 10,000 rows | 274 | 309 | 48.7 | 8.5 | 17.8 | 34.7 | 200 | 0.0 | **16%** |
| append 1,000 rows | 27.9 | 32.2 | 4.5 | 1.1 | 0.0 | 4.3 | 22.3 | 0.0 | **14%** |
| clear 1,000 rows | 3.3 | 3.9 | 3.2 | 0.0 | 0.0 | 0.4 | 0.2 | 0.0 | **83%** |
