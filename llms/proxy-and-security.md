# Proxies, security headers and compression

## Common tasks

### Read the visitor's address behind a proxy

`proxy` in kay.config.ts says how many proxies sit in front, so `rateLimit` and `clientAddress` count the visitor and not the proxy, `true` for one:

```ts
export default defineConfig({
  proxy: true,
})
```

### Allow another image host in the Content-Security-Policy

`security.csp` merges directives over kay's, and `headers` adds a header such as `permissions-policy` or a longer HSTS:

```ts
import { defineConfig } from 'kay/server'

export default defineConfig({
  security: {
    csp: { 'img-src': ['\'self\'', 'https://images.example.com'] },
    headers: { 'strict-transport-security': 'max-age=63072000; includeSubDomains' },
  },
})
```

### Try a stricter policy before enforcing it

`reportOnly` sends the merged policy as `Content-Security-Policy-Report-Only`, and `reports: true` has browsers report what it would have blocked to kay's own route:

```ts
export default defineConfig({
  security: {
    reportOnly: { 'style-src': ['\'self\''] },
    reports: true,
  },
})
```

### Compress responses

In production kay compresses pages, action results and routes' responses with zstd, brotli or gzip on its own; `compress: false` turns it off behind a proxy or CDN that compresses already, and `compress: true` turns it on elsewhere:

```ts
export default defineConfig({
  compress: false,
})
```

## Reference

### Behind a proxy

- A server behind nginx, Caddy or Cloudflare is reached from the proxy rather than from the visitor, so the address `rateLimit` and `clientAddress` count is the proxy's for every visitor until `proxy` in kay.config.ts says how to read the visitor's:

```ts
export default defineConfig({
  proxy: true,
})
```

- `proxy: false` is none, as left out; `proxy: true` is one proxy in front, `proxy: 2` two: the short forms of `{ hops: 1 }` and `{ hops: 2 }`.
- `hops` is the number of proxies in front, each appending the address it was reached from to `X-Forwarded-For`, so the visitor is the entry `hops` from its end: 1 for nginx or Caddy alone, 2 for Cloudflare then nginx.
- A request with fewer entries skipped an outer proxy, and its first entry is who reached the inner one.
- `header` names a header a proxy sets to the visitor's address, read instead: `{ header: 'cf-connecting-ip' }`, or `{ header: 'x-real-ip' }` for nginx's `proxy_set_header X-Real-IP $remote_addr`.
- Only a proxy every request goes through can be trusted with it: a server reachable past that proxy lets a visitor write their own, and the same goes for `hops` when an outer proxy can be skipped.
- Either is read only from a request coming from this machine, a private network (loopback, private, shared and link-local ranges) or a range `trusted` lists, so a visitor reaching the server directly is counted by their own address whatever headers they send.
- A server a CDN reaches directly from its public addresses lists them: `proxy: { header: 'cf-connecting-ip', trusted: ['173.245.48.0/20', '2400:cb00::/32', ...] }` with every range Cloudflare publishes, each entry an IPv4 or IPv6 range or a single address; nginx or a tunnel such as cloudflared in front does as well.
- A request from a public address outside them that carries the header warns once, as such a CDN setup misses its `trusted`, and counts by its own address.
- A setting holding both, or neither, stops the server.
- The proxy passes `X-Forwarded-Proto` on every location, websockets included (nginx: `proxy_set_header X-Forwarded-Proto $scheme`), as kay's cookies are `Secure` and the session's named `__Host-session` over https: a request that says `http` reads no session.
- A request without the header counts as https in production when `site` is https; with no `site`, production warns once that cookies go out without `Secure`.
- A post goes back to its page as a path and never reads a forwarded header for it, so the swap works behind a proxy that ends TLS with nothing declared for it.
- Without `proxy`, the address the request came from is the client.
- A server getting requests from a private address that carry `X-Forwarded-For` warns once that every visitor counts as the proxy.
- In a plain Elysia app that `pages()` does not serve, `clientAddress(request, server, { hops: 1 })` takes the setting itself.

### Security headers

- Every response the app sends, its own routes included, carries a Content-Security-Policy, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `X-Frame-Options: SAMEORIGIN` (following `frame-ancestors`, below), `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Resource-Policy: same-site`, `X-Permitted-Cross-Domain-Policies: none` and `Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()`.
- The policy:

```text
default-src 'self';
script-src 'self' <kay's hashes>;
style-src 'self' 'unsafe-inline';
img-src 'self' data: https:;
font-src 'self';
connect-src 'self';
object-src 'none';
base-uri 'self';
form-action 'self';
frame-ancestors 'self'
```

- Every inline script kay writes is the same on every page: the hydration bootstrap, the speculation rules, the swap of streamed blocks, with `offline` the service worker's registration, and, in development, live reload and what keeps the problems kay logs, the errors nothing caught and the sources the policy blocked until the dev tool loads.
- The policy allows them by hash, with no `'unsafe-inline'` and no nonce.
- `security` in `kay.config.ts` adjusts it:

```ts
import { defineConfig } from 'kay/server'

export default defineConfig({
  security: {
    csp: {
      'img-src': ['\'self\'', 'https://images.example.com'],
      'frame-ancestors': false,
    },
    reportOnly: { 'style-src': ['\'self\''] },
    reports: true,
    headers: {
      'strict-transport-security': 'max-age=63072000; includeSubDomains',
    },
  },
})
```

- `csp` merges directives over kay's, one given `false` left out.
- `'wasm-unsafe-eval'` and `worker-src 'self' blob:` join kay's directives and the app's when the islands need them, unless the app sets that directive to `false` or `'none'` (see [Wasm and workers](styles-and-assets.md#wasm-and-workers)).
- `script-src`, and `script-src-elem` when the app sets one, keep kay's hashes whatever they list.
- With `fonts`, a `style-src` or `style-src-elem` without `'unsafe-inline'` gets the hash of their inline `@font-face` rules, and with stylesheets a page may inline (see [Styles](styles-and-assets.md#styles)) the hash of each of them, one with `'unsafe-inline'` none, since a hash would switch it off.
- `'script-src': false` leaves kay's inline scripts to `default-src`, which blocks them, islands and streamed blocks with them.
- `csp: false` sends no policy, and `security: false` none of these headers.
- `X-Frame-Options`, for browsers that predate `frame-ancestors`, follows the policy's, a page's own sources included: `DENY` for `'none'` or no source, `SAMEORIGIN` for `'self'` alone, and none for any other source, or without the directive.
- An app's `x-frame-options` in `headers` still wins; with `csp: false` it stays `SAMEORIGIN`.
- `reports: true` has browsers report what the policy blocks to kay's own route, `/_kay/csp` under the site's `base`, through `report-to` and its `Reporting-Endpoints` header, and `report-uri` for browsers that predate them.
- The route takes both formats, logs each violation once per process for its directive, what it blocked and the page, and hands it to `onError` as a `CspViolationError` from `kay/server`, with `directive`, `blocked`, a URL or `inline` or `eval`, `url`, the page without query or hash, `disposition`, `enforce` or `report`, and, when the browser says, `source`, the script that tried as `file:line:column`, and `sample`, the start of a blocked inline script or style when the directive lists `'report-sample'`.
- A client posting more than 30 reports a minute or 64 KB at once is refused, and with `site` set, a report about a page of neither the `site` nor the request's own origin is answered `204` but neither logged nor handed to `onError`, as anyone can post one; with `i18n.domains` no report is filtered. It is noise filtering, not authentication.
- `reports: 'https://...'` sends them to that collector instead, and kay serves no route.
- `reportOnly` merges directives over the enforced policy and sends the result as `Content-Security-Policy-Report-Only`: the browser blocks nothing it allows, but reports what that stricter policy would have blocked, with `disposition: 'report'`, to try it before moving it into `csp`.
- With `csp: false`, it merges over kay's directives.
- `headers` merges headers over kay's, one given `false` not sent.
- `Strict-Transport-Security: max-age=31536000` (a year, no `includeSubDomains`, no `preload`) is sent on every response the app serves in production when `site` (`SITE_URL`, `ORIGIN`) is https, behind a `proxy` too, and never in development, for an http or unset `site`, or with `security: false`. `'strict-transport-security': false` in `headers` (or a page's `security.headers`) turns it off, and a value replaces it: `'max-age=63072000; includeSubDomains'`. A static export writes the security headers as `_headers` and `headers.nginx.conf` ([Static export](prerendering.md#static-export)), HSTS in the first only: the scaffold's `nginx.conf` sends it itself, always with one year, so a server in front of your own export sets it, in each `location` that has an `add_header` of its own too, as nginx drops the server-level ones there.
- `Cross-Origin-Resource-Policy: same-site` keeps another site from loading the images, scripts and files the app serves, so an app whose files another site embeds sends `'cross-origin-resource-policy': 'cross-origin'`.
- `Cross-Origin-Opener-Policy: same-origin` cuts a page off from a window of another site it opened, or that opened it, so a sign-in or payment popup that answers through `window.opener` needs `'cross-origin-opener-policy': 'same-origin-allow-popups'`.
- A site using a feature `Permissions-Policy` refuses, such as geolocation for a map, sends its own, `'permissions-policy': 'geolocation=(self)'`, which replaces kay's.
- A header the app sets itself, in an Elysia `onRequest` or a handler, wins over kay's.
- The build's files under `/_kay/` and the image route carry kay's headers in their own responses, which Elysia does not let a later hook override: change them there through `headers`.
- A page, or a layout for every page under it, adds to them for its own responses with `security` in its `page`: `export const page = { security: { csp: { 'script-src': ['https://cdn.example.com'], 'worker-src': ['blob:'] }, headers: { 'cross-origin-embedder-policy': 'require-corp' } } }` isolates an emulator page and lets its CDN script in, the rest of the site keeping the strict policy.
- Its `csp` adds sources to the site's directives rather than replacing them, a directive the policy lacks starting from the one the browser falls back to, `worker-src` from `child-src` then `script-src`, `frame-src` from `child-src`, and `'none'` dropping out, so a page cannot tighten a directive the site sets; `false` leaves a directive out, `'script-src': false` blocking kay's inline scripts and hydration with them, as in `kay.config.ts`; `csp: false` as a page's whole value sends that page, and the pages under a layout setting it, no policy at all, as `security: { csp: false }` does the site.
- Its `headers` merge over the site's, `false` not sending one, and go out even with `security: false`.
- A layout's apply first, the page's over them.
- The swap loads a page whose cross-origin isolation differs from the current one fully, so going to and from an isolated page needs no `data-reload`.
- A static export has no server to send them: `kay build --static` writes the page without its `security` and `reload`, which the host's own headers stand in for.
- `inlineScriptHashes({ prefetch, dev, base, offline })` from `kay/server` gives the hashes, for a policy written elsewhere, such as by a proxy.
- Whatever the policy, a `javascript:`, `vbscript:` or `data:text/html` URL bound to an `href`, `src`, `action`, `formaction`, `xlink:href`, `poster` or `data`, as a user-supplied link would be, goes out prefixed with `unsafe:`, on the server and in islands, so following it does nothing.
- One written out as text in the template is left as it is.

### Compression

- With NODE_ENV production, kay compresses responses itself unless kay.config.ts sets `compress: false`, as behind a proxy or CDN that compresses already (`compress: true` turns it on elsewhere): pages rendered per request, action results, and any `Response` the app's routes registered after `.use(await pages())` return go out (text, JSON, JavaScript, XML, SVG, ndjson and `ttf` and `otf` fonts) with zstd, brotli or gzip, whichever the browser's `Accept-Encoding` prefers (zstd, then gzip, then brotli on a tie), and `Vary: Accept-Encoding`.
- A response whose body is whole within a tick, as a rendered page is, is compressed in one go at zstd 3, brotli 4 or gzip 6, within its request's tick up to 128 KB and at most four at once off the main thread past it, the copy of a body rendered alike a second time kept (2 MB in all) so later ones are not compressed again, and a streamed body or a reply compressed once (sitemap, worker) as brotli or gzip, except a page carrying inlined stylesheets, which goes as gzip to a browser taking it, whatever weight it gives zstd or brotli, only what lies around them compressed, and its copy kept like any other's when the same bytes lie around them again, found from the pieces the render put the page together from without reading its body (see [Styles](styles-and-assets.md#styles)). A page draws its `uid()` ids, island prefixes and `await` block numbers from its route and URL, so every visit to a URL renders the same bytes unless the page reads the visitor (a name, a form carrying a fresh token), and only that kind of page is compressed again on each visit.
- A server build sends a page as its difference from a dictionary, Compression Dictionary Transport (RFC 9842, `Content-Encoding: dcz`): the dictionary is the 404 page of the build (default locale, rendered with its layouts, only when a page is prerendered and the render succeeds), written by `kay build` as `_kay/dictionary-<hash>.txt` with `Use-As-Dictionary: match="/*"` (`match="<base>{/*}?"` under a `base`, with no `match-dest`, which Chromium reads as no `Available-Dictionary` on a `fetch()` page swap) and the immutable cache, and every HTML response carries `Link: <_kay/dictionary-<hash>.txt>; rel="compression-dictionary"` and `Vary: Accept-Encoding, Available-Dictionary`. A browser fetching it once idle sends `Available-Dictionary: :<sha256>:` and `Accept-Encoding: ..., dcz` for pages under the mount point, a navigation or a `fetch()` alike, and gets `dcz` when the header names this build's dictionary exactly and `dcz` has a weight; anything else (another build's dictionary, a malformed or oversized value) gets the encodings above. A prerendered page is served from its `.dcz` copy written beside `.br` at build time (zstd 19, kept only when smaller than the `.br`, tag suffix `-dcz`); a page rendered per request is compressed on the fly at zstd 3 through `node:zlib`, whole bodies only, with its kept copies keyed by the dictionary, while a streamed page stays brotli or gzip. Off in development, with `compress: false` (no link, no `.dcz` served), in `kay build --static` and in an export, which have no dictionary; the browser fetches the dictionary under `connect-src`, so kay adds `'self'` to the app's own `connect-src` as it adds what islands need, unless the app removed the directive or set it to `'none'`, which keeps today's encodings.
- A public text file of up to 256 KB is kept in memory once asked for (8 MB in all) and read again only when its size or date changes, so a request for it does not read the file; a range request and a larger file stream from disk. Development reads every request. Every request looks at the file's size and date: a public file deleted under a running server answers the 404 an unknown path gets (the routes directory's `_404.kay`, else its `_error.kay`, in the visitor's locale), a runtime redirect added for its path answers, and the visit is counted as any missing path is, except for a file that goes between that look and the opening of its body to stream or compress it, which answers a plain 404 of Elysia's with no page and no count (an app giving `new Elysia({ serve: { error } })` its own handler answers it instead), and a replaced one answers its new bytes under a tag taken from its new size and date.
- A streamed page is flushed chunk by chunk, so what it sends early still arrives early.
- A strong ETag becomes weak.
- Left alone: a response encoded already, such as the build's copies, one under 256 bytes, its length known or not, one with `Cache-Control: no-transform`, and anything but text, JSON, JavaScript, XML and SVG.
