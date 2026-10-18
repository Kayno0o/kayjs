---
title: File storage
order: 5.5
description: Store uploads on disk or in an S3 bucket, link and resize them from pages, keep private files behind signed links and show upload progress.
---

## Storing an upload

`files` from `kay/server` keeps what visitors upload. An action stores the `File` it got with `files.put`, which resolves with a key for the app to save. A page links it with `files.url(key)`.

```kay
--- server
import { s } from 'kay'
import { files } from 'kay/server'
import { photos } from '../photos'

export const upload = action(s.Object({ photo: s.File({ type: 'image/jpeg' }) }), async ({ photo }) => {
  photos.push(await files.put(photo, { folder: 'photos' }))
}, { bodyLimit: '20mb' })
---
form(action={upload})
  input(type="file" name="photo" aria-label="Photo")
  button Upload
for key of photos key={key}
  img(src={files.url(key)} alt="")
```

A key looks like `photos/1f3a9c0b2d4e6f8a0b1c.1600x1200.jpg`. An image's key holds its size, so `img` gives a stored image the same responsive variants as an imported one, without opening the file.

A JPEG, PNG or WebP is stored without the metadata a camera or phone writes in it, such as where and when the photo was taken. Its colour profile and orientation stay. Use `files.put(file, { keepMetadata: true })` to store it byte for byte.

`/_kay/files/<key>` serves each file with its type, cached for good. Images, video, audio, PDFs and plain text are shown in place. Any other file is sent as a sandboxed download, so an HTML page never runs as the site.

### Replacing and deleting

Keys are never reused, so a new avatar is a new file. `files.put(file, { replace: user.avatar })` deletes the old one once the new one is stored. `files.delete(key)` deletes a file with every resized variant and social card of it.

### Finding unused files

`files.list({ folder })` resolves with each stored file's `key` and `modified`, when it was last written. Use it to find the files nothing references any more. `files.variants(keys)` names the variants made of each key.

### What the browser does with a file

A browser shows a file in place only when that runs nothing: a PNG, JPEG, WebP, GIF or AVIF image, a video, audio, a PDF or plain text. Any other file is sent as a download, under a `sandbox` policy.

So an uploaded HTML page never runs as your site. Nor does a script or a stylesheet, because every file but an image goes out as `application/octet-stream`.

An SVG is sent as a download too, but it keeps its type, so it still shows in an `img`. Every file also has `X-Content-Type-Options: nosniff`.

<ReadMore href="/llms/files#storing-and-linking">The file route's caching and ranges, and how a stored image gets its variants, are in the full files reference.</ReadMore>

## Private files

`files.put(file, { private: true })` stores a file that only a signed link reaches. `files.url(key)` signs one, valid for an hour.

The page rendering the link, behind its guard, decides who gets the file. Use `files.url(key, { expires: '1d' })` for a longer link.

The link is signed with the app's `secret` or `KAY_SECRET`. See [Config](/reference/config).

A route of your own can answer with `files.response(key, request)` instead.

A link is `/_kay/files/<key>?until=<time>&sig=<signature>`. The signature covers the key and the time it expires, so changing either breaks it. A link stays valid for an hour, and `files.url(key, { expires: '1d' })` makes it longer.

The time is rounded up to the next ten minutes at most. Pages rendered a few minutes apart then give the same link, which the browser keeps cached.

The key that signs is made from the session's secret. Without `session()` it comes from `secret` in `kay.config.ts` or `KAY_SECRET`, then from the preview secret. Without any, it is a key made for the process. A restart changes it, several processes do not share it, and a production server warns about it once.

A script that signs a link with no server running reads `KAY_SECRET`.

On disk, private files are written readable by the server's user alone, and the folder where kay keeps copies and resized variants of them is closed to other users too. Nothing to set up.

<ReadMore href="/llms/files#private-files">How a script outside the server reads the secret, and how a private image is resized, are in the full files reference.</ReadMore>

## Where files go

Files go to `data/files` on the server's disk unless `storage` in `kay.config.ts` says otherwise. An S3 bucket, or R2, Spaces or MinIO, reads its settings from the usual `S3_*` variables.

```ts
import { defineConfig, s3Files } from 'kay/server'

export default defineConfig({
  storage: s3Files({ publicUrl: 'https://files.example.com' }),
})
```

`publicUrl` is where the bucket serves files itself. A static export links stored files there.

The bucket serves each file by its extension, not by the type the visitor said it had. Images, video, audio, PDFs and plain text show in the page. Anything else, such as an uploaded HTML page or SVG, is stored as a download, so it never runs as part of your site. An SVG still works in an `img`. Files stored by an earlier release keep the type they were uploaded with, so put them again. Serve the bucket from a host that shares no cookies with your app.

Under `bun test`, files stay in memory, each `testSite` with its own.

### Your own store

`storage` takes any object of `FileStore`, from `kay/server`. It reads, writes and deletes a file by key. Keys are never written twice, so it needs no locking.

```ts
import type { FileStore } from 'kay/server'

const storage: FileStore = {
  write: async (key, data) => { await bucket.put(key, data) },
  read: async key => await bucket.get(key) ?? undefined,
  delete: async (key) => { await bucket.remove(key) },
}
```

`read` resolves with `undefined` when no file has that key. Three members are optional:

- `list(prefix?)` resolves with `{ key, modified? }` for each file under the prefix. `files.list()` needs it.
- `path(key)` is where a store on this machine's disk keeps a file, which the image route reads in place.
- `publicUrl` is where the files are reachable over HTTP without kay. A static export links there.

### S3 options

`s3Files` takes Bun's S3 client options too. Use `virtualHostedStyle: true` for a service that wants the bucket in the host name.

```ts
s3Files({ bucket: 'uploads', endpoint: 'https://s3.example.com', virtualHostedStyle: true })
```

## Upload progress

An island calling an action with a file reads `upload.progress()`, from 0 to 1 while the browser sends it.

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

<ReadMore href="/llms/files">Custom stores, how links to private files are signed and what a static export accepts are in the full reference.</ReadMore>
