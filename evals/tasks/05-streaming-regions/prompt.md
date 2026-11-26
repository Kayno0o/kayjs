# Task 05: Streaming Suspense & Partial Region Swaps

Build a searchable article/library catalog page at `/` that combines streaming `<Suspense>` with `<Region>` partial HTML swaps using `@kayjs/spa` (`regions()`).

## Requirements

1. **Plugin Setup (`kay.config.ts`)**:
   - Register `regions()` from `@kayjs/spa` in `kay.config.ts`.

2. **Search & Detail Page (`src/routes/index.tsx`)**:
   - Have a dataset of at least 5 items (each with `id`, `title`, `category`, `summary`), including clearly distinct searchable titles (for example containing words like `Signals`, `Streaming`, `Regions`, `Actions`, `Auth`).
   - Render a `<form method="get" data-kay-target="results" data-kay-live>` with `<input name="q" value={q} data-kay-sync />` and a submit `<button type="submit">` so it works with and without JS.
   - Render category or item filter links `<a href="/?q=..." data-kay-target="results">`.
   - Wrap the dynamic results pane in `<Region name="results" aria-label="Search results">` (from `@kayjs/kay`).
   - Inside `<Region name="results">`, wrap an async server component (e.g. `<AsyncResults query={q} />` that awaits a small async lookup) in `<Suspense fallback={<p>Loading results…</p>}>` so the results stream cleanly.
   - Set `<Head><title>...</title></Head>` reflecting the active query.

3. **Verification**:
   - `kay check` and `kay build --analyze --max-js 15kb` pass.
   - `GET /` returns full HTML (`<!DOCTYPE html>`) with `data-kay-region="results"` and streamed items.
   - `GET /?q=<term>` works without JS (full HTML with filtered items).
   - `GET /?q=<term>` with header `x-kay-region: results` returns only the region HTML (no `<!DOCTYPE html>`), sets `Vary: x-kay-region`, and includes the filtered results.
