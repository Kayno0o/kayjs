---
title: File storage
order: 5.5
description: Store uploads on disk or in an S3 bucket, link and resize them from pages, keep private files behind signed links and show upload progress.
---

## Storing an upload

`files` from `kay/server` keeps what visitors upload. An action stores the `File` it got with `files.put`, which resolves with a key for the app to save, and a page links it with `files.url(key)`:

```kay
--- server
import { action, s } from 'kay'
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

A key looks like `photos/1f3a9c0b2d4e6f8a0b1c.1600x1200.jpg`: an image's key holds its size, so `img` gives a stored image the same responsive variants as an imported one without opening the file. Keys are never reused, so a new avatar is a new file: `files.put(file, { replace: user.avatar })` deletes the old one once the new one is stored.

`/_kay/files/<key>` serves each file with its type, cached for good. A file a browser could run as the site, an HTML page or an SVG, is sent as a download.

## Private files

`files.put(file, { private: true })` stores a file only a signed link reaches. `files.url(key)` signs one valid an hour, `files.url(key, { expires: '1d' })` longer, so the page rendering it, behind its guard, decides who gets the file. A route of your own can answer with `files.response(key, request)` instead.

## Where files go

Files go to `data/files` on the server's disk unless `storage` in `kay.config.ts` says otherwise. An S3 bucket, or R2, Spaces or MinIO, reads its settings from the usual `S3_*` variables:

```ts
import { defineConfig, s3Files } from 'kay/server'

export default defineConfig({
  storage: s3Files({ publicUrl: 'https://files.example.com' }),
})
```

`publicUrl` is where the bucket serves files itself: a static export links stored files there. Under `bun test` files stay in memory, each `testSite` with its own.

## Upload progress

An island calling an action with a file reads `upload.progress()`, from 0 to 1 while the browser sends it:

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
