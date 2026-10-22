# Uploads and image fields

How a `fileField()` and an `imageField()` upload, what the editor shows, and the unused-uploads screen.

## Common tasks

### Store an image with its alt text and size

`imageField({ alt, width, height })` names fields beside it; the editor asks for the alt text under the image and stores its pixels, so the page gives `image` its size.

```ts
s.Object({
  photo: imageField({ alt: 'photoAlt', width: 'photoWidth', height: 'photoHeight' }),
  photoAlt: s.Optional(s.String()),
  photoWidth: s.Optional(s.Integer()),
  photoHeight: s.Optional(s.Integer()),
})
```

### Narrow what a field takes

`imageField({ accept, maxSize, minWidth, minHeight })` and `fileField({ accept, maxSize })` narrow the types, weight and pixels for one field, checked in the editor before the file is sent.

```ts
s.Object({
  cover: imageField({ accept: ['image/png', 'image/jpeg'], maxSize: '2mb', minWidth: 1200 }),
  brochure: fileField({ accept: ['application/pdf'] }),
})
```

### Upload several images at once

A list of them has a zone of its own taking several files at once, one item appended per file.

```ts
s.Object({ gallery: s.Array(imageField()) })
```

### Show an uploaded image on a page

The field keeps the path the site serves, so the page renders it as it renders any image.

```kay
img(src={entry.data.photo} alt={entry.data.photoAlt})
```

### Clean up unused uploads

`<prefix>/uploads` lists the uploads no entry mentions, each with the variants it would take with it, and deletes the ones you confirm, with a `guard`; `POST /_kay/cms/files/unused/delete` takes `{ keys }`.

```ts
await fetch('/_kay/cms/files/unused/delete', { method: 'POST', body: JSON.stringify({ keys }) })
```

## Reference

- A file dropped or picked on an image or file field goes to `POST /_kay/cms/files/:collection`, `uploads.maxSize` at most (20 MB by default), an empty file refused 400, a bigger one 413, which stores it public through kay's `files.put` in one folder every collection shares, `cms-media`, named by the hash of its bytes (the same file sent twice is stored once and answers the same path; kay strips the EXIF a camera writes in it), and records its name, size, who sent it and when in a private index beside the files, and the field keeps `files.url(key)`, `/_kay/files/<key>`; a list of them, `s.Array(imageField())`, also has a zone of its own taking several files at once, which uploads them one after the other and appends one item per file in order, a refused one told by the field while the others still land; a typed path works as well, in the field's `Path` control, which an upload the CMS stored does not show, so a page renders either with `img(src={entry.data.photo})`.
- An image pasted or dropped into a Markdown body, the entry's or a `markdown` field's, goes to the same endpoint and is embedded as `![](path)` where the cursor is; the pickers offer only the types `uploads` takes (images for an image field) and `GET /_kay/cms/files/rules` tells the editor them with the size limit, so a dropped file they miss, or one over the size, is told by the field with its type or size, and a refused upload in a Markdown body is toasted and leaves the text as it was.
- Replacing or removing a file leaves the old upload stored: the unused-uploads screen at `<prefix>/uploads` lists the uploads of the shared folder, and those an older release stored in a collection's folder, that no entry mentions, in any collection, locale, draft or loaded collection, each with the image variants it would take with it, and deletes only the ones you confirm, and only with a `guard`.
- Uploads under a day old, or that the storage dates not at all, are held back: a save the site has not rebuilt from, another server's save or an unsaved form may use them.
- A URL written by hand in a page, a file of the repository outside the collections or an older revision a revert brings back is not seen either, so check each upload before you confirm; the screen lists nothing while a collection or entry cannot be read, or the storage cannot list its files.
- `POST /_kay/cms/files/unused/delete` takes `{ keys }` and deletes those still unused, answering `{ deleted, kept }`, or 409 while the entries cannot be read.
- An image or file field shows the file name as a link opening it in a new tab, a Clear button, a compact drop zone with its button beside it, a progress bar with a Cancel button while it uploads and its failure under the field, and a `Choose an uploaded file` picker (`GET /_kay/cms/files/:collection`, `?images=true` for images) listing the shared uploads and those in the collection's own folder; a preview that fails to load says so.
- The field says what it takes: the types, the size and the pixels.
- Save is refused with a toast while an upload runs, and the browser asks before the page is left.
- `imageField({ accept, maxSize, minWidth, minHeight })` and `fileField({ accept, maxSize })` narrow what the editor takes for that field (`accept` as `uploads` does, `maxSize` in bytes or `'2mb'`), checked in the editor, before the file is sent, while the route keeps applying `uploads`.
- `imageField({ alt, width, height })` names fields beside it (keys of the same object, which the form no longer shows): the editor asks for the alt text under the image and previews it with that text, and stores the width and height of every image uploaded, picked or typed in kay storage's naming (`<id>.<w>x<h>.png`), so a page gives `image(post.photo, { width: post.photoWidth, height: post.photoHeight, alt })` its size; a list item has no sibling, so these apply to a field in an object. A text field called `alt` is the first image's alt text with no hint. A layout naming a paired field gets a boot warning saying so, and `EntryField` throws naming the image; a paired field can still be a list column. A refused width or height shows under the image. Leaving the page while a file uploads asks first.
- An object field is drawn as one block with a rule down its left side.
- The media library at `<prefix>/media` lists every upload of the shared folder and of the collections' older folders, the newest first, with a preview (a resized variant, so a page of photos stays light), its name, size, pixels, who sent it and when, and the entries using it (the first three, linked, and a count); a search box filters by name and the list pages 48 at a time (`?q=`, `?page=`); an upload sent before the library has no recorded size, which is read from the stored file. Rename changes the name the library shows (`POST /_kay/cms/files/media/rename` with `{ key, name }`), never the key, so no reference changes; Delete is offered for an upload no entry mentions that is over a day old, under the unused-uploads rules and with a `guard`. The screen lists nothing while an entry or a collection cannot be read.
- Which entries use an upload is read from every collection, locale and draft the server can read, as the unused-uploads screen does; an unsaved form in an editor's browser is not seen.
- Uploads an older release kept in a folder per collection are moved by the CMS itself when the server starts, with nothing for the app to run: every one an entry names is copied into `cms-media` under the hash of its bytes (two files with the same bytes become one), its rename and sender carried to the copy, and the entries naming it, in any field, list, block, body or locale, are saved pointing at the copy through the configured saver, each against the version it was read at (one commit per entry on Forgejo). A server started at the same time, or an entry saved since, makes that entry conflict and wait for the next start. The old file is kept, hidden from the library and the pickers, and listed by the unused-uploads screen once no entry names it. An upload no entry names stays where it is. A run finding nothing to move writes nothing.
- An `imageField()` or `fileField()` holds a path the site serves, or an http(s) address: any other scheme (`javascript:`, `data:`) fails the schema, whatever the editor typed.
