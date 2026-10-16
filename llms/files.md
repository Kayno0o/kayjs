# Stored files

`files` from `kay/server` keeps what visitors upload and links it from pages: an action stores the `File` it got and saves the key, a page renders `files.url(key)`.

Images are resized as imported ones are, and private files go only to a link kay signed.

## Common tasks

### Store an uploaded file and show it

`files.put` stores the `File` an action got and resolves with its key, which the app saves where it keeps its data, and `files.url(key)` is the link a page renders:

```kay
--- server
import { s } from 'kay'
import { files } from 'kay/server'
import { photos } from '../photos'

export const upload = action(s.Object({ photo: s.File({ type: 'image/jpeg' }) }), async ({ photo }) => {
  photos.push(await files.put(photo, { folder: 'photos' }))
}, { bodyLimit: 20 * 1024 * 1024 })
---
form(action={upload})
  input(type="file" name="photo" aria-label="Photo")
  button Upload
for key of photos key={key}
  img(src={files.url(key)} alt="")
```

### Replace a stored file

`replace` deletes the old file once the new one is in:

```ts
import { files } from 'kay/server'

const key = await files.put(file, { folder: 'avatars', replace: user.avatar })
```

### Delete a stored file

`files.delete(key)` deletes it, a key with no file being no error:

```ts
import { files } from 'kay/server'

await files.delete(key)
```

### Keep a file private

`private: true` gives a key starting `private/`, which a page behind its guard links with `files.url(key)`, signed and valid an hour:

```ts
import { files } from 'kay/server'

const key = await files.put(file, { private: true })
const link = files.url(key, { expires: '1d' })
```

### Decide in a route who gets a file

A route of the app's own answers with `files.response(key, request)`:

```ts
import { api, files } from 'kay/server'

export default api().get('/*', ({ params, request }) => files.response(params['*'], request))
```

### Keep files in an S3 bucket

`storage` in kay.config.ts says where files go, `s3Files` any service speaking the S3 API:

```ts
import { defineConfig, s3Files } from 'kay/server'

export default defineConfig({
  storage: s3Files({ publicUrl: 'https://files.example.com' }),
})
```

### Show how much of an upload was sent

An island calling an action with a file reads `upload.progress()`, from 0 to 1:

```kay
---
import { upload } from '../routes/photos.kay'

async function send(event: Event) {
  const input = event.currentTarget as HTMLInputElement

  await upload({ photo: input.files![0]! })
}
---
input(type="file" aria-label="Photo" onChange={send})
if upload.progress() !== undefined
  progress(value={upload.progress()})
```

## Reference

### Storing and linking

- `files.put(file, options)` stores a `File` or `Blob` and resolves with its new key, `photos/1f3a9c0b2d4e6f8a0b1c.1600x1200.jpg`, for the app to save where it keeps its data.
- The extension is the file name's, else its type's, else `bin`; an image's key holds its size, which `img` and `image()` read off it without opening the file.
- A key is never written twice, so replacing a file stores a new one: `files.put(file, { replace: user.avatar })` deletes the old one once the new one is in.
- `folder` is letters, digits, `-` and `_` in segments split by `/`, and does not start with `private` in any case.
- `files.url(key)` is where a page links it, a path of the site as a template's `href` is, written without the base: `/_kay/files/<key>`.
- The route serves it with its type, cached for good since a key never changes, and answers the range a video player asks for.
- Only a PNG, JPEG, WebP, GIF, AVIF, video, audio, PDF or plain text file is shown in place; any other is sent as a download under a `sandbox` policy, so an HTML page or an SVG never runs as the site, and every file but an image goes as `application/octet-stream`, so a script or a stylesheet never loads into one of its pages (an SVG keeps its type, so it still shows in an `img`); every file has `X-Content-Type-Options: nosniff`.
- A key under `private/` is private whatever its case.
- `img(src={files.url(key)})` and `image(files.url(key), { sizes })` give a stored PNG, JPEG, WebP, GIF or AVIF the same variants as an imported image, with its size; an animated GIF is answered as it is.
- `shareImage` and `shareCard` take one too.
- `files.get(key)` resolves with the file as a `Blob`, or `undefined`; `files.delete(key)` deletes it with every variant and social card the image route made of it, a key with no file being no error.
- A JPEG, PNG or WebP is stored without the EXIF, XMP, IPTC, text chunks and comments a camera or phone writes in it, such as where the photo was taken, keeping its colour profile and a JPEG's orientation; `files.put(file, { keepMetadata: true })` stores it byte for byte (see [Privacy](privacy.md)).
- `files.list({ folder })` resolves with `{ key, modified }` for each file stored, `modified` being when it was last written when the store knows, in no order; with a `folder` (named as in `files.put`) only the files directly in it. `files.variants(keys)` resolves with a `Map` from each key to the names of the variants and social cards the image route made of it, which `files.delete` removes with the file.
- Each throws on a key `files.put` never gives, `../` say.

### Private files

- `files.put(file, { private: true })` gives a key starting `private/`, which `/_kay/files/` serves only to a link `files.url(key)` signed: the page rendering it is what decides who gets the file, behind its guard.
- The link stays valid an hour, `files.url(key, { expires: '1d' })` longer, rounded up to the next ten minutes so a page rendered again soon gives the same link, which the browser keeps cached.
- It is signed with a key derived from the session's secret, else from `secret` in kay.config.ts or `KAY_SECRET`, else from the preview secret, else a key of the process, which a restart changes, which several processes do not share, and which a production server warns of once. A script signing one with no server reads `KAY_SECRET`, and `secret` in the kay.config.ts beside it once it has used the store (`files.put`, `files.get`).
- A private image is resized through its signed link, its variants kept by no shared cache.
- A route of the app's own that decides by itself who gets a file answers with `files.response(key, request)`: the file, its range included, kept by no cache.

### Stores

`storage` in kay.config.ts says where files go: `diskFiles('data/files')` from `kay/server` by default, relative to where the server runs, as the job store is.

```ts
import { defineConfig, s3Files } from 'kay/server'

export default defineConfig({
  storage: s3Files({ publicUrl: 'https://files.example.com' }),
})
```

- `s3Files(options)` keeps them in an S3 bucket, or any service speaking its API, such as R2, Spaces or MinIO; options left out are read from `S3_BUCKET`, `S3_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY`, as Bun's S3 client reads them, and it takes the client's own options, `virtualHostedStyle` say.
- `/_kay/files/` streams them from the bucket, whole, and the image route copies an image it resizes once into its cache.
- `publicUrl` is where the bucket serves its files without kay, which a static export links; the bucket serves each file with the type it was uploaded with, none of the above, so files the site's visitors upload belong on another origin than the site's.
- `memoryFiles()` from `kay/server` keeps them in the process; `FileStore` is the shape of an app's own: `write`, `read` and `delete` by key, `list(prefix?)` for `files.list` to work, resolving with `{ key, modified? }` for each file under the prefix, which the built-in stores have, and `path` for one on this machine's disk, which the image route reads in place.
- A script or a test that started no server reads `storage` from the kay.config.ts where it runs.
- Under `bun test` files stay in memory, and `testSite` gives each site a store of its own unless its options name one.
- `kay build --static` fails on a page linking a stored file, which has no server to serve it, unless the store has a `publicUrl`: the page then links the file there, unresized.
- A private file always fails it.

### Upload progress

An island calling an action with a file reads how much of it the browser sent, from 0 to 1, as `upload.progress()`, reactively, `undefined` before and once the call settled:

```kay
---
import { upload } from '../routes/photos.kay'

async function send(event: Event) {
  const input = event.currentTarget as HTMLInputElement

  await upload({ photo: input.files![0]! })
}
---
input(type="file" aria-label="Photo" onChange={send})
if upload.progress() !== undefined
  progress(value={upload.progress()})
```
