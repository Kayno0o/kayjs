# Images uploaded at runtime and from other hosts

## Common tasks

### Resize images uploaded at runtime

`images.dirs` lists a directory by the URL path the app serves it at, and `image()` gets the size for the variants:

```ts
import { defineConfig } from 'kay/server'

export default defineConfig({
  images: { dirs: { '/uploads/': 'data/uploads' } },
})
```

```kay
---
import { image } from 'kay/image'

const { post } = props<{ post: { photo: string, photoWidth: number, photoHeight: number } }>()
---
img({...image(post.photo, { width: post.photoWidth, height: post.photoHeight })} alt="")
```

### Resize images from another host

`images.remote` lists the hosts, each an `http` or `https` origin:

```ts
import { defineConfig } from 'kay/server'

export default defineConfig({
  images: { remote: ['https://cms.example.com/uploads/', 'https://*.cdn.example.com'] },
})
```

```kay
---
import { image } from 'kay/image'

const { post } = props<{ post: { cover: { url: string, width: number, height: number } } }>()
---
img({...image(post.cover.url, { width: post.cover.width, height: post.cover.height })} alt="")
```

## Reference

### Runtime and remote images

- An image `files.put` stored is resized with no setting, its size read off its key: `img(src={files.url(key)})` (see [Stored files](files.md)).
- Images added at runtime another way are resized too from a directory listed by the URL path the app serves it at: `images: { dirs: { '/uploads/': 'data/uploads' } }` in `kay.config.ts`, relative to the root, or to where an executable runs.
- Give their size, `image(post.photo, { width: post.photoWidth, height: post.photoHeight })`, for the variants; without it the image keeps its `src` alone. kayjs-cms fills `photoWidth` and `photoHeight` in when the field is `imageField({ width: 'photoWidth', height: 'photoHeight' })` (see [Content CMS](content-cms.md)).
- Each variant is made once per version of the file and revalidated by its ETag, since an upload can change in place; one over 50 megapixels is refused with 413 from its header alone.
- The variants the route draws on request, for runtime, stored and remote images, are kept in `.kay/cache/images`; the server removes those nothing wrote for 30 days as it starts and once a day, and the next request draws one again.
- A variant the server cannot write, its cache directory full or read-only, is the server's error, a 500 its error log reports, rather than the 415 of a file kay cannot resize.
- kay does not serve the originals: the app does.
- Images the app looks up its own way, such as by a database id, behind a session: `images.resolve: (src, ctx) => mediaPath(src)` gives the file of a `src` nothing above names, a path relative to the root, or undefined for a 404, and `images.guard: guard(ctx => { if (!ctx.locals.session.get('userId')) ctx.deny(401) })` runs before it, as a page guard does.
- `ctx` is a guard's: `ctx.url.searchParams.get('src')`, the session and `deny()` or `redirect()`, in `resolve` too.
- Its `ctx.locals` holds what the app's plugins add, such as the session, but not Elysia's `cookie`, `query`, `headers` or `body`, which `ctx.cookies`, `ctx.url` and `ctx.request` give, and what the guard sets on `ctx.headers` or its cookies goes out with the image.
- With `resolve` set, `image('/media/42', { width, height })` resizes any `src` starting with `/`, a file extension or not; these answers are `Cache-Control: private, no-cache`, revalidated by their ETag, a refusal `private, no-store`, and a static export refuses `resolve`, having no route.
- The `src` is what any visitor typed: look it up, or `safePath('media', name)` from `kay/server`, never a plain join, as the path `resolve` returns is read as it is, `../` and symlinks followed; `resolve: src => safePath('media', src.slice('/media/'.length))` gives the real path of a file inside `media`, or undefined for a 404 (see [Files from a folder](server.md#files-from-a-folder)).
- `images.guard` without `resolve` fails the boot.
- Images on another host, such as a CMS, a CDN or an old WordPress, are resized too from a host `images.remote` lists: `images: { remote: ['https://cms.example.com/uploads/', 'https://*.cdn.example.com'] }`, each entry an `http` or `https` origin, its host starting with `*.` for any subdomain of a domain (`*.com`, `*.co.uk` and `*.vercel.app` are refused: a wildcard never covers a public suffix, of which kay knows the common ones, not the whole list), and maybe a path every URL starts with.
- An entry may name `http:`, `localhost` or an IP, as a CMS running beside the app in development does.
- A download goes only to public addresses: each hop, redirects included, resolves its host once and connects to the address it checked, answering 502 when any answer is loopback, private (`10/8`, `172.16/12`, `192.168/16`), link-local (`169.254.169.254`), unique-local (`fd00::/8`), reserved, or such an IPv4 address inside an IPv6 one (`::ffff:127.0.0.1`), whatever the spelling of the IP. An entry naming one address or `localhost` (`http://10.0.0.5:9000`, `http://localhost:9000`) is the app's own host and may be private; a host listed by name never may, so an internal CDN is listed by its address. The host is asked directly (`HTTP_PROXY` is not read) and a compressed answer is refused.
- A download is cut off past 25 MB and given up on after 10 s, answering 413 and 502: `images: { remote: [...], remoteMaxSize: '10mb', remoteTimeout: '30s' }` changes them, a size such as `'10mb'` or bytes, a duration such as `'30s'`.
- Give their size, `image(post.cover.url, { width: post.cover.width, height: post.cover.height })`, for the variants, which the route makes from a copy it downloads into `.kay/cache/images/remote` and keeps for the host's `Cache-Control: max-age`, a minute to a week, an hour without one, then asks again with its ETag or date; a changed image gets new variants under a new ETag.
- A host that fails leaves the last copy served, and one that never answered is asked again a minute later, the route answering 502 meanwhile.
- A host not listed is refused with 403, as is a redirect to one, so the route is no open proxy.
- A path without its final slash covers itself and what is below it, `/uploads/a.jpg` but not `/uploads-private/a.jpg`.
- On the server, `image()` and `shareImage()` leave an absolute URL no entry covers as it is, as content from a CMS may hold one, warning once per host, and `shareCard()` throws for one.
- A download is cut off past 25 MB or 10 seconds, and an image over 50 megapixels is refused with 413, as an upload is.
- Since any URL of a listed host may be asked for, a new query each time, at most 500 originals are kept, up to about 13 GB on disk at 25 MB each plus the variants made of them, the least recently used going first with their variants, and one client starts at most 30 downloads a minute, the route answering 429 past them.
- The variants are served from the site, so the CSP's `img-src` needs no entry for the host.
