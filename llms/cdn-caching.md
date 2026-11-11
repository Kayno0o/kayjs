# A CDN in front of prerendered pages

A prerendered page with a `ttl` tells a shared cache how long to keep it, so a CDN in front of the server serves it without reaching the origin. For everything the server caches and for how long, see [what is cached](rendering.md#what-is-cached-and-for-how-long).

## Common tasks

- Let a CDN keep a page an hour: `ttl: '1h'` in its `page` export.
- Send a header of your own: `cacheControl: 'public, max-age=300'`, or `false` to keep the page out of shared caches.

```kay
--- server
export const page = { prerender: true, ttl: '1h' }
---
h1 Blog
```

## Reference

- A public page with a `ttl` of T answers `cache-control: public, max-age=0, s-maxage=T, stale-while-revalidate=T`: the browser asks each time, a CDN keeps the page T and serves it up to T more while the server renders it again. A change reaches the CDN after its `s-maxage` at the latest, or at its own purge.
- `revalidate` is the name `ttl` had before 1.87 and is gone since 1.91: a page setting it fails `kay check`.
- A page never gets the shared header when it is behind a guard, rendered for the visitor (a context, a flash cookie, the dev tool), or the lighter copy sent to a `Save-Data` visitor: those keep `private, no-cache`, `private, no-store` or `public, max-age=0, must-revalidate`. A response that sets any cookie, from the session, kayjs-auth or kayjs-cms, or from a route of the app, is made `private, no-cache` as well (`keepCookiesPrivate` from `kay/library` does it for a plugin of your own).
- A page that sets a `cache-control` of its own (`ctx.headers.set(...)`) keeps it, a page answering another status than 200 gets none, and a background render that stores its own header keeps it.
- `cacheControl: 'public, max-age=300'` in `page` sends that text instead, `false` keeps `public, max-age=0, must-revalidate` whatever the `ttl`. A layout's `ttl` and `cacheControl` apply to every page under it, the innermost winning. A `cacheControl` that is empty, holds a line break or is no string fails the build with `page-settings-invalid`.
- `kay build --static` writes the same value to `_headers`, for each such page at its path under the `base`, with and without the trailing slash (the root as `/base` and `/base/`). A path holding a `*`, a `:` or a space is left out, no `_headers` is written when it would be empty, and a `public/_headers` keeps its rules, kay's block following them without a header the file names. `headers.nginx.conf` carries no `cache-control`, as an nginx `include` cannot say a header per path.
