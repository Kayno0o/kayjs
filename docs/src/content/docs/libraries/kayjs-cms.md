---
title: kayjs-cms
order: 4
description: Edit a kay site's content on the page it renders, and manage each collection from screens generated from its schema.
---
`@kaynooo/kayjs-cms` edits a kay site's [content collections](/guides/content) in two ways. Edit mode opens the real page: click a title, edit it in a sidebar, and the page updates as you type. The screens, generated from each collection's schema, list, search, add, edit, publish and delete entries.

Both save the same way. A file entry is a Forgejo commit, or a change in the working tree under `kay dev`. A loaded entry goes through its collection's loader.

## Install

```sh
bun add @kaynooo/kayjs-cms @kaynooo/kayjs-ui @iconify-json/tabler
```

The `@kaynooo` scope must point at the Forgejo registry. A project made by `kay new` already has it in its `.npmrc`; for another, see [Installation](/getting-started/installation).

kay and kayjs-ui are peers. The editor is drawn with kayjs-ui, so the app imports [its theme](/libraries/kayjs-ui#theme). kayjs-cms is released with kay, at kay's own version, and peers on kay's minor. Install the one matching your kay and move them together.

An app on a `^0.x` range moves to kay's version by hand, as a caret on 0.x never reaches it.

## Setup

In a kay project, `kay add cms` installs the packages and adds the extension below with its defaults. Otherwise, put `cms()` in `kay.config.ts`'s `extensions`.

```ts
import { cms, forgejo } from '@kaynooo/kayjs-cms'
import { defineConfig } from 'kay/server'

export default defineConfig({
  extensions: [cms({
    // Who may use the screens and save; edit mode alone only reads. Loaded on the first request, so this file imports nothing of the app's auth or database.
    guard: { load: async () => (await import('./src/auth')).auth.guard({ require: 'editor' }) },
    // Left out, a file entry is written in the working tree, for `kay dev`: a production server refuses to boot so.
    files: process.env.FORGEJO_TOKEN ? forgejo({ url: 'https://git.example.com', repo: 'me/site', token: process.env.FORGEJO_TOKEN }) : undefined,
  })],
  // Edit mode is kay's preview mode: it needs the secret signing its cookie.
  preview: { secret: process.env.PREVIEW_SECRET },
})
```

The screens live at `/admin`. Set `prefix` to move them, to `/` if the site is only the screens. At `/` the screens keep their own chrome and guard even when your app has a root layout or guard: they mount in a `(admin)` group, which adds nothing to a URL. They stay closed without a `guard`. They fit a phone, so a client can edit from one: the entry lists stack as cards and the controls stay big enough to tap.

`guard` also takes the built guard itself, `auth.guard({ require: 'editor' })`. Then `kay.config.ts` imports `./src/auth`, and with it the app's database, for every `kay build` and `kay check`.

## Edit mode

In edit mode, kay renders the editor at the end of every page, with the entries the page read, in the order the page shows them, so the forms stay in place as you type. The "Edit on page" links on the screens put an editor the guard admitted in edit mode. The editor's "Stop editing" button leaves it. With changes not saved, it asks first: Keep editing, or Drop them and stop.

An entry has such a link when a page shows it. That is the page listing its collection in `prerender` or `sitemap`. For an entry read by its slug, such as a section of the home page, it is the first page without params that reads it. The cms finds that page by rendering those pages once in edit mode, the first time it needs one, and keeps the answer for a few minutes. An entry no page shows has no link.

### Edit this page

A signed-in editor reading the site finds an "Edit this page" button in the bottom left corner of every page, which opens edit mode on it. There is nothing to add to the app, and the pages stay static.

Opening any screen of the admin marks the browser with a `kay_editor` cookie, readable by the page. So does signing in with [kayjs-auth](/libraries/kayjs-auth), which sets its own `kay_user` cookie that the script treats the same way, so an editor sees the button on the first page after signing in.

Every page carries one short script that looks for either cookie, so a visitor without them loads nothing more. With one, the page asks the guard whether the editor is still signed in. If so, the button shows. If not, the cookie is deleted and the button never shows. The button does not show on the admin screens or in edit mode.

With another way of signing in, an editor who never opened the admin sees no button until they open it once.

To place the link yourself, write an `a(data-cms-edit-page hidden)` in your layout. The cms fills in its address, shows it, and writes its text when it is empty, instead of drawing its own button. `cms({ pageLink: false })` turns the button off, and the hint cookie with it.

The editor never covers the page it edits. From 64rem wide it docks to the right and moves the page's body aside by its width. On a narrower window, and always below 40rem, it is a sheet at the bottom and pads the page by its height, so the page keeps its width and a fixed header at the top stays in view. At the side, the editor starts under a header fixed or sticky across the top of the window, so the header stays visible, and the dev tool's bar and floating drawer sit outside it.

The header it looks for touches the top and is at most 240px tall. One the page adds later is found on the next scroll or resize.

While the page updates, the editor says so in a line screen readers announce. If an entry you edited does not pass its checks, the page shows its saved text until it does, the editor names it, and the other entries keep their preview. Your unsaved edits show again on the next page you open in the site. After a save to a forge, the editor reminds you for five minutes that the live site may still show the old content, also after you leave edit mode and come back.

Drag the editor's inner edge, or focus it and press the arrow keys, to resize it. The button in its head docks it to the other edge, and the hide button folds it into one button. It remembers the edge, the size and whether it is hidden in the browser.

What you type is kept in the browser, so a reload, a crash or a second tab brings it back with a note saying so. Save, Reset and Stop editing clear it. A draft is kept a week at most, and one made from an older copy of the entry than the saved one is left out with a note, so it never writes over a newer save. Reloading, closing the tab or following a link with changes not saved asks first.

Stop editing clears every kept draft of the browser, but a draft left by a visit that ended another way stays until the week passes, and the edit cookie names no user, so on a browser several people sign in to, they should leave with Stop editing. Where the browser gives no storage, edits are only kept until the page closes.

When the dev tool is docked to the right or the bottom, the editor sits beside it instead of under it. Clicking an element of the page scrolls it above the sheet when the sheet would hide it.

An edit cookie or link is tied to no user, so it reads only the entries the pages it showed in edit mode read, never a customer or order collection the page does not render. A signed-in editor the guard admits reads any entry. The list of those entries lives in the server's memory, so after a restart, or on another replica, load the page again.

Once there is a guard, every save needs it, edit mode included. Without one, saving from an edit link works under `kay dev` only: any other server refuses every save, publish, delete and upload from an edit cookie or link, and warns at boot to set `cms({ guard })`. With a guard, `author` names who a save is committed as, such as the signed-in user.

Without `author`, the forge commits as the account behind its token, so no editor's name or email reaches git. Give `author` the real name and email only when the editors agree to appear in the history: a commit cannot be erased from it later, so a request to delete someone's data (RGPD art. 17) cannot reach their name there. A pseudonym keeps the history useful and the editor private:

```ts
author: async ({ locals }) => {
  const user = await locals.auth.user()
  return user && { name: `Editor ${user.id}`, email: `${user.id}@users.noreply.example.com` }
}
```

## Who else has an entry open

The screen of a saved entry says when someone else has the same entry open, so two editors do not overwrite each other. It names them when `author` gives a name, which is the name the other editor sees for you too, and only counts them when it does not: "1 other editor". The same editor in two tabs is not listed to themselves. A new entry shows nothing, as no one else can have it open.

The editor on a page shows the same line above its form, in the warning colour. It asks no `author`, so it counts its editors. The entry list marks an entry "Being edited", by name when the editors have one.

A list watches through a room of its own, so it is no editor of the entry to anyone, and it marks the first 50 rows of a page. It also shows "Being edited" for your own other tab on the page editor. A named editor is told of editors without a name as "1 other editor". Every open tab on one of these holds a live connection, so a browser on HTTP/1 allows a host only a few.

A screen of your own built from the parts shows the same list by passing `presence` to `EntryEditor`, or `room` and `member` to `EntryPresence`. `entryPresence(ctx, collection, entry)` from `@kaynooo/kayjs-cms/presence` returns both.

## Collection titles

The screens title a collection with its export's name, humanized: `blogPosts` shows as "Blog posts". A collection can say its own title with the `title` option, which suits a site that is not in English:

```ts
export const produits = collection('src/content/produits', { schema, title: 'Produits' })
```

The name keeps naming the collection's URL, its markers and its upload folder.

A `description` option adds a line under the title, on the collection's list and on its entries, to tell an editor what the collection holds.

## A collection of one entry

Some content is one entry, such as the texts of a home page. Declare the collection `single`, and the admin shows it as that page, not as a list of one row:

```ts
export const home = collection('src/content/home', {
  schema: s.Object({ headline: s.String(), intro: s.String() }),
  title: 'Home page',
  single: true,
  seed: { headline: 'Welcome', intro: '' },
})
```

The content list links to the form, which is titled "Home page". It has no slug field, no New entry and no Delete, and the way back leads to the content list. The entry is saved as `index`. The CMS refuses a second entry or a delete, whoever asks.

`seed` is what the form holds until the entry is written. The first save writes it, so the app seeds nothing by hand. Read the entry in a page with `one()`:

```ts
const { headline } = await home.one()
```

`one()` gives the entry's data, else the `seed`, else `undefined`. Give it a fallback to get the data typed, `await home.one({ headline: '', intro: '' })`. A single collection cannot be `localized`. If it already holds several entries, such as a list you turned into one, the admin and `one()` show the first and the others are out of its reach, so keep one.

## Ordering entries

A collection listed in a hand-picked order names a number field with `order`:

```ts
export const produits = collection('src/content/produits', { schema: s.Object({ name: s.String(), position: s.Optional(s.Number()) }), order: 'position' })
```

`all()` then lists the entries by that field, those without a number last, and the entry list shows Up and Down on each entry. A move saves the field of the two entries that swap places, so the editor never types a number. If several entries hold the same number, or none, a move numbers the entries from 1. A search hides the buttons, as the rows no longer follow the order.

## Choices

A union of literals or an enum is picked from a list. A literal's `title` is what the list shows, and the value stays what is saved:

```ts
status: s.Union([
  s.Literal('available', { title: 'Disponible' }),
  s.Literal('new', { title: 'Nouveau' }),
  s.Literal('sold', { title: 'Vendu' }),
])
```

A literal with no `title` shows its value.

## Lists

An array field is a list of items. A list of single values, such as strings, shows its label once and then one compact row per item. A list of groups folds each item away under a title, the first text field filled in, or `Item 3` when none is. The list shows how many items it holds, and the `minItems` and `maxItems` of the schema: Add and Duplicate stop at the maximum, Remove at the minimum.

A new item starts from the `default` of the item's schema, and a select with no default stays unpicked.

Up, down, duplicate and remove buttons sit beside an item, and Alt+Shift with the up or down arrow moves it from inside its fields, a multi-line text excepted. Removing an item says so and offers Undo, and focus goes to the item that took its place, or to the new item after Add. A screen reader is told where a moved item landed, such as `Moved Tag to 2 of 3`, or `Moved Item 1 to 2 of 3` in a list whose items are numbered, naming the place the item left. The order saved is the order shown.

A list also has Add at the top, and a menu to jump to an item once it holds eight or more. A folded item shows how many issues it hides, such as `2 issues`. Reset asks before it drops your unsaved changes.

## How a field is entered

The schema already shapes each control. A string with `format: 'email'` or `'uri'` gets an input of that type and stays on one line, whatever its `maxLength`. A `maxLength` limits the box and shows a counter such as `12 / 254`. `minimum` and `maximum` set the limits of a number. An `integer` takes no decimal point, and the mouse wheel over a number box leaves it instead of changing the figure. Emptying an optional text unsets the field, and a toggle shows its description and its issue.

For what a schema cannot say, wrap the field in `fieldInput()` from `kay/content`:

```ts
import { fieldInput } from 'kay/content'

s.Object({
  price: fieldInput(s.Number({ minimum: 0 }), { suffix: '€', placeholder: '600' }),
  bio: fieldInput(s.String(), { rows: 6 }),
  status: fieldInput(s.Union([s.Literal('draft'), s.Literal('live')]), { labels: { draft: 'Brouillon', live: 'En ligne' } }),
  tags: fieldInput(s.Array(s.String()), { lines: true }),
  linkLabel: fieldInput(s.Optional(s.String()), { when: 'link' }),
})
```

The price is a number, stored as `600`, with the euro sign beside the box. `rows` makes a text a box of that many rows that grows as you type. `labels` names the values of an enum. `lines` enters a list of strings in one box, a line each, and emptying it on an optional field leaves the key out.

`when` shows a field only once a field next to it has a value, and the server warns at boot when no field is next to it; use it on an optional field, and know that a hidden field the schema refuses is shown with its message. `placeholder`, `prefix`, `suffix` and `type` (`'tel'` say) shape a one-line box, and `titleField` names the field of a list's items that heads each one.

## Field kinds of your own

A field the admin should edit another way, such as a colour or a rating, is declared in the schema with `customField(kind, schema)` from `kay/content`, and edited by `src/cms/fields/<kind>.kay`. There is nothing to register: the editor bundles every file in that folder.

```ts
import { customField } from 'kay/content'

s.Object({ accent: s.Optional(customField('color', s.String({ pattern: '^#[0-9a-f]{6}$' }))) })
```

```kay
---
// src/cms/fields/color.kay
import type { CustomFieldProps } from '@kaynooo/kayjs-cms'

const { value, onChange, label } = props<CustomFieldProps>()
---
label {label}
  input(type="color" value={typeof value === 'string' ? value : '#000000'} onInput={event => onChange(event.currentTarget.value)})
```

The component gets `value`, `onChange`, `label`, `hint`, `issue` (why the last save refused the field) and `required`. A save checks the value against the schema alone, so a `pattern` or a union refuses a bad one. A kind with no file is edited as JSON, with a hint naming the file to add in development only, and the server logs a warning at boot for it.

A file added while `kay dev` runs is picked up on the next reload. `customField` refuses the name of a kind the editor has built in, such as `text`, `image` or `reference`.

## Files and images

An image or file field (`imageField()`, `fileField()` from `kay/content`) takes a file dropped or picked. It is stored through kay's [file storage](/guides/file-storage), and the field keeps the path that serves it. The file name is a link that opens it in a new tab, and a Clear button empties the field. An empty field shows a slim drop zone with its button beside it, and under it what the field takes: the types, the size and, for an image, the pixels.

An editor who would rather type a path finds a collapsed Path control, shown while the field is empty or holds an address typed by hand. It takes a path or an `http:` or `https:` address, and refuses any other scheme such as `javascript:` or `data:`. A file the CMS stored needs no path, so the control is not shown for it.

While a file uploads, the field shows a progress bar and a Cancel button. A file that fails is explained under the field, not only in a message that goes away. Save refuses while an upload runs, because the field is not set until it ends, and the browser asks before the page is closed.

Under the zone, Choose an uploaded file lists what the collection's folder already holds, so a file is used again without uploading it twice. If the image cannot be shown, the field says so instead of a broken picture.

An image field can ask more of its files, and pair itself with the fields next to it:

```ts
photo: s.Optional(imageField({ accept: ['image/png', 'image/jpeg'], maxSize: '2mb', minWidth: 800, alt: 'photoAlt', width: 'photoWidth', height: 'photoHeight' })),
photoAlt: s.Optional(s.String()),
photoWidth: s.Optional(s.Integer()),
photoHeight: s.Optional(s.Integer()),
```

`accept`, `maxSize`, `minWidth` and `minHeight` narrow what `uploads` takes for that field alone; the editor checks them before it sends the file. `fileField` takes `accept` and `maxSize`.

The fields named by `alt`, `width` and `height` leave the form. The editor asks for the alt text under the image, previews the image with it, and fills in the width and height of every image uploaded or picked, so a page can give them to `image()`. A text field called `alt` needs no hint: it is the alt text of the first image beside it.

These pairs work for a field of an object, not for the items of a list. An object field is drawn as one block with a rule down its left side.

A list of them, such as `s.Array(imageField())`, has a zone of its own that takes several files at once: each is uploaded in turn and added as a new item, in the order given, and a file the server refuses is reported under the zone while the others still land.

An image pasted or dropped into a Markdown body is uploaded the same way and embedded where the cursor is. A refused upload shows a message and leaves the text as it was.

A file field takes PNG, JPEG, WebP, GIF, AVIF and PDF files. Set `uploads` to list others, such as `['image/*', 'application/pdf']`. The file picker offers only those types, and a file over the size limit or of another type is refused, the field telling its type or size, an empty one too.

The server also reads the file's first bytes. A file named `photo.png` that holds a web page, a JPEG or half a header is refused as not a real `image/png`, whatever name or type the browser sent, and the name counts in any case, so `PHOTO.PNG` is a PNG. PDF and SVG files are checked the same way. A type with no signature, such as a CSV, is taken as named.

Storage serves anything but a PNG, JPEG, WebP, GIF, AVIF, video, audio, PDF or plain-text file as a download that cannot run as your site, so an SVG you allow is safe in an `img` and never opens as a page.

An upload may weigh 20 MB by default. `uploads: { types, maxSize }` sets either, `maxSize` in bytes or as a string such as `'50mb'`, for a site of videos or large PDFs, or `'2mb'` for a portfolio that wants less; a part left out keeps its default.

The upload route takes `maxSize` whatever the app's `bodyLimit` is, so nothing else is raised. The editor refuses an oversized file before sending it, and the server stays the one that decides. A size that is zero, negative, not a whole number of bytes or over 128 MB less 64 KB stops `kay.config.ts` from loading: Bun refuses a request body over 128 MB before the route sees it, and the upload is buffered in memory.

`pageSize` sets how many entries a collection's list shows on a page, 50 by default.

Replacing or removing a file leaves the old upload stored. The unused-uploads screen at `<prefix>/uploads` lists the uploads no entry mentions, and deletes only the ones you confirm, and only with a `guard`.

Check each upload before you confirm. A URL written by hand in a page, or a file outside the collections, is not seen as a use.

<ReadMore href="/llms/kayjs-cms">Which uploads the unused-uploads screen holds back, and when it lists nothing.</ReadMore>

## Pages visitors cannot find

When a visitor asks a production server for a page it does not have, kay counts the path. The screen at `<prefix>/not-found` lists those paths, the most visited first, with the sites visitors came from, the pages of your own site that linked there, the time of the last visit and, where kay can tell, the page they most likely meant. Paths that a redirect already answers are left out.

A page of your site counts as having linked only when the visit's `Host` is your site's: behind a proxy that does not forward it, only the hosts are kept.

Each path has an Add redirect button: one click for the suggested target, or a box to type the target of a path with no suggestion. The target box offers the pages of your site that hold what you type.

The redirect is saved where the running server reads it, so it answers at once, with no deploy, and the path leaves the list.

Below the list, the redirects added here show Edit, to give a path another target or status, and Remove, which undoes one. A 301 or 302 stored earlier keeps its status when you change only its target. Tick several rows to remove them at once. The redirects of `kay.config.ts` are listed after them, to read. All of it needs the `guard` you gave `cms()`.

A redirect answers with a 307, which browsers do not keep, so Remove undoes it for everyone. Tick Permanent beside Add redirect for a 308 instead: browsers keep it, so Remove does not reach a visitor who has followed it already.

A redirect added here can only go to a page of your site, and kay refuses a loop or a target no page serves. To allow another site, list its host in `runtimeRedirects` in `kay.config.ts`. You can also copy the line into `redirects` in `kay.config.ts`, or run `kay not-found --redirect <path>`, to keep the redirect in the repository.

A path that is gone for good, such as a page you retired, takes Gone instead: it answers 410, which tells search engines to drop it. A 410 has no target.

A path that is only noise, such as a mistyped link from nowhere, takes Dismiss. It leaves the list and comes back if a visitor asks for it again. Clear the list forgets them all.

The target box suggests the pages of your site as you type.

The buttons call `POST /api/cms/redirects` with `{ from, to, status }`, where `status` is 307, 308 or 410. `POST /api/cms/redirects/remove` takes `{ froms }`, `/dismiss` takes `{ paths }` and `/clear` takes nothing. A refusal comes back as a 400 with its reason. Your own code may call them too, and they need the same `guard`.

## Languages

Every text the screens and the editor show, `Edit this page`, `Save`, `Not valid JSON`, is looked up in your messages before its English. Word them once in `src/messages/<locale>.ts` under `cms`, named for the area and the text, and the screens and the editor read them, the editor in the browser.

```ts
// src/messages/fr.ts
export default defineMessages({
  cms: {
    editor: { title: 'Modifier cette page', stop: 'Arrêter de modifier' },
    admin: { entryCount: { one: '{count} entrée', other: '{count} entrées' } },
  },
})
```

kayjs-cms ships the French of all of them. A site whose locale is `fr` shows French screens and a French editor with nothing declared, and the `fr.ts` above only changes the words you want worded differently. For another language, write the same `cms` block in that locale's file: each key you leave out reads the English.

A key a locale lacks reads the English, and `kay check` leaves the `cms` keys out of its comparison between locales. The API's refusals are worded in the locale of the page that called.

<ReadMore href="/llms/kayjs-cms">Every `cms.*` key and its English is in the full kayjs-cms reference.</ReadMore>

## Raw HTML in a body

A Markdown body whose HTML would run as the site or cover it is refused on save. That is anything kay's sanitizer drops, such as a `<script>`, an `onclick`, a `style`, a `javascript:` link, or a tag left open for the page around it to close.

List the collection in `rawHtml` to allow it. The collection's own components and HTML shown in a code block are always fine.

## Collections from a loader

A collection whose entries come from a loader has no files to commit. Give it `save` and `remove` beside `load`, and the screens and edit mode write through them.

```ts
export const news = collection({
  name: 'news',
  load: async () => (await listPosts()).map(post => ({ slug: post.slug, data: { title: post.title }, html: post.content })),
  save: async ({ slug, data, create }) => {
    if (create)
      await createPost(slug, data)
    else
      await updatePost(slug, data)
  },
  remove: async ({ slug }) => deletePost(slug),
}, {
  schema: s.Object({ title: s.String() }),
})
```

`create` is `true` for a new entry. Throw then if the entry exists, so another editor's new entry is not overwritten.

kayjs-cms calls them through `saveEntry` and `removeEntry` from `kay/content`, after checking the entry against the schema. Never call those two from inside `save` or `remove` of the same collection, as they wait for each other.

## Where files are saved

A folder entry is a file, and `files` says where it goes. `forgejo()` commits it. `workingTree()` writes it in place, which is the default under `kay dev`. The token travels with every request, so `forgejo()` throws for a plain `http:` address unless it is `localhost`, `127.0.0.1` or `[::1]`.

A production server refuses to boot on the working tree, as the next deploy would drop its saves. Name `workingTree()` yourself where the files outlive a deploy.

Any `{ save(change) }` is a saver. `change` has the file's `repoPath`, its new `text` (`undefined` to delete it), a commit `message` and the `base` version it was edited from.

```ts
import type { FileSaver } from '@kaynooo/kayjs-cms'
import { fileVersion, SaveConflict } from '@kaynooo/kayjs-cms'

const saver: FileSaver = {
  async save({ absolute, text, base }) {
    const file = Bun.file(absolute)
    const current = await file.exists() ? fileVersion(await file.bytes()) : null

    if (base !== undefined && base !== current)
      throw new SaveConflict(current)

    if (text === undefined)
      await file.delete()
    else
      await Bun.write(absolute, text)

    return undefined
  },
}
```

`base` is `null` for a new file and `undefined` to write whatever is there. A saver that finds another version throws `SaveConflict`, which the editor shows with its Keep my edits button.

## The entries API

The editor, the sidebar and the screens change entries through one API under `/api/cms/entries/:collection/:slug`. `GET` answers the collection and the entry with its `version`; add `?locale=` for a localized entry. A missing entry is a 404. `POST` saves, `DELETE` deletes, `POST` to `…/publish` publishes a draft and `POST` to `…/unpublish` makes a published one a draft. `POST` to `…/move?direction=up` or `down` reorders. kay checks the data against the schema before anything is written.

## Saves and conflicts

Save is disabled until something changed, and Ctrl or Cmd+S saves from anywhere on the screen or in the editor on the page. While a save is on its way the fields are locked. Next to the buttons, a line says where the entry stands: `Saving…`, `Unsaved changes`, or `Saved at 14:32`. When the site shows a save only after it has rebuilt, the line says `Not live yet` and links to the page.

Publish, Unpublish, Publish now and Clear schedule each change one field and save it. With unsaved edits they refuse and ask you to save or cancel them first, so they never save half-typed text. If the save is refused, the form goes back to how it was. Delete names the entry, warns that the page of one that has a page stops answering, and lists the entries that name it in a reference field.

After a save the site shows only once it has rebuilt, the line by the buttons says `Not live yet` until the public page serves the change, then `Live now`.

A commit shows on the site once it has rebuilt from it. The Forgejo token needs write access to the repository's contents, and the commit is the token's user's.

A save or a delete made over another save is refused rather than writing over it. So is one made over your own save before the site rebuilt from it. The refusal stays on the form, names the fields both sides changed, and offers Take their version, which drops your edits for the saved copy. Its Keep my edits button lets the next save write your edits over that save.

A loaded entry is protected the same way, and your loader does not have to give a version: kayjs-cms compares what the loader returns for the entry now with what the editor opened. If another editor or your app changed it meanwhile, the save or the delete is refused and the form offers Keep my edits. A save that leaves the content as it was does not count as a change.

Only the fields the schema declares are compared, so a loader that adds computed fields, such as a url or a read time, or that changes them on every read, causes no false conflict. A save still sends every field the entry has, so a field the loader changed meanwhile that the schema does not declare is written back as the editor opened it.

Saves and deletes of one collection are checked and written one after the other in the server, but two servers behind one app do not wait for each other.

A loader that returns something new on every read, such as the current time in a field, makes every save conflict, so keep such fields out of the entry. Each save costs the loader two more reads, and a delete one.

A save that takes over 15 seconds (`timeout`), or a forge out of reach, fails with the reason. It says so when the commit may still have gone through.

A repository checked out with CRLF line endings, or using SHA-256 object names, gives files another version than the editor computes, so every save conflicts.

## Fixing a refused save

When the server refuses a save, the form takes you to what is wrong. The focus goes to the first field to fix and the page scrolls to it. Above the form, a list names every field to fix, and each line links to its field. A screen reader hears each field's message once, not the list again. On the page editor the list also holds the problems the preview finds as you type.

Fixing one field clears that field's message and leaves the others. A field the form does not show gets a message of its own above the form, with no link.

The form also checks as you type. A field with a minimum or maximum length, a pattern, or a minimum or maximum number gets the matching limit on its input, and says what is wrong once you leave it. A required field is marked `required` on every control, and a pattern becomes the input's own `pattern` only when it is anchored at both ends (`^...$`) and has no `\p{...}` or `\u{...}` escape and no character beyond the basic plane, since HTML anchors a pattern itself.

The form checks any other pattern. The server still decides on a save.

A JSON box that does not parse blocks the save. It says `Meta is not valid JSON` under the box, and nothing is sent until you fix it. A slug that is already taken is marked on the slug field, and typing another one clears it.

### Writing the slug

On a new entry of a folder collection, the slug writes itself from the title as you type it, so `Été à la ferme` becomes `ete-a-la-ferme`. Latin accents are dropped and letters of other scripts are kept, so `Привет мир` becomes `привет-мир`. Their marks stay too, Greek accents and Arabic vowel signs included.

A title with no letter or digit leaves the slug empty and the box says to type one. Typing in the slug box takes over and turns that off. The checkbox under the box turns it on again, and so does clearing the box.

What you type in the slug box is cleaned as you type: accents go, spaces become dashes and capitals become lowercase. A `/` stays, to put the entry in a folder. A loaded collection keeps the slug as typed.

The slug is marked as taken the moment the collection holds it. Under the box the form says which folder the entry lands in, which folder it creates, and when a new folder looks like a typo of an existing one (`No folder guidse yet: did you mean guides?`). It reads the slugs from `GET /api/cms/slugs/:collection`, for signed-in editors only.

## Arranging a collection

The screens read each collection's schema. To change how one looks, name it in `cms({ collections })`:

```ts
cms({ collections: { shop: {
  form: { fields: ['price', ['stock', 'live'], 'photo'], hide: ['sku'] },
  list: { columns: ['price', 'live'], actions: ['delete'] },
} } })
```

In the form, `fields` come first, in that order. A list inside it is a row of columns, which stack where there is no room. The other fields follow in the schema's order, then the Markdown body, which you name `body`. `hide` leaves a field out. A hidden field that a save refuses still shows its message above the form.

In the list, `columns` are field keys shown after the title, and `actions` keeps some of a row's `move`, `publish`, `unpublish`, `editOnPage` and `delete`. A list, group, JSON or custom field cannot be a column.

The editor on the page follows the form's layout too. A name twice, or an action that does not exist, throws when `kay.config.ts` loads. A field the schema lacks logs a warning at boot.

## Scheduling an entry

A collection with `publishAt: 'publishAt'` (see [Scheduling an entry](/guides/content#scheduling-an-entry)) shows that date field in the entry form like any other. The editor sets, changes or clears it and saves. The cms only edits the field: kay shows the entry at that time, with no job in your app.

In the list, a published entry whose date is ahead has a `Scheduled for` badge in the Status column, and the entry screen shows the same badge. Both name the time in the editor's own time zone, such as `Scheduled for 2026-10-20 10:00 GMT+2`, once the browser says it, and in UTC before. The badge goes by itself when the date passes, back to `Published` in the list. A draft stays a draft, so Publish on a draft with a date confirms the schedule.

Beside the badge, Publish now dates the entry now and Clear schedule removes its date, each saving at once.

A collection with `unpublishAt` also shows an `Ends 2026-10-20 10:00 GMT+2` badge on the entry screen while that date is ahead, and `Ended` once it passes, because the site no longer shows the entry. Clear end date beside it removes the date and saves at once. The date field itself is edited like any other date.

The date and time input shows the time of the editor's own time zone, whatever the server's, and names the zone under the field. What the editor types is stored as the exact moment it names, so an editor in Paris and one in New York see the same entry at their own hours. A time the clocks of the zone skip, on the night they go forward, is stored an hour on. A date field you clear stores nothing.

## Replacing a screen

Write a page at the screen's path, such as `src/routes/admin/collections/shop/[...slug].kay`. It replaces that screen and leaves the others. The cms guard still runs before your page. With `prefix: '/'` the path is under the group, `src/routes/(admin)/collections/shop/[...slug].kay`.

The screens have a chrome of their own, with none of your site's layouts, header or footer around them. It has a skip link, a nav with Content, Missing pages and Unused uploads, and a link back to the site. Every title ends in `Content admin`, which you reword with `cms.admin.brand`.

Give the header a logo with `cms({ logo: '/logo.svg' })`, a file of `public/` or an https URL, shown before the name. The pages are `noindex`, and they take kayjs-ui's theme, light or dark as the device is, so the app needs Tailwind and its build plugin, as kayjs-ui does. The `seo` and fonts of `kay.config.ts` and your security headers still apply, but not the CSS or head tags your root layout adds.

An entry screen heads its title with crumbs: Content, then the collection, each a link. A `src/routes/admin/_layout.kay` replaces that layout for all the screens. It holds the chrome, the toaster, the tooltip host and the stylesheet `@kaynooo/kayjs-cms/admin.css`. Render kayjs-ui's `Toaster` and `TooltipHost` and import that stylesheet to keep them. Set `export const page = { layouts: false }` in yours to stay clear of the site's layouts as the default does.

In the page, read what the screen reads with `entryScreen`, `listScreen` and `collectionScreen` from `@kaynooo/kayjs-cms`, then render a component of your own, or the screens' own `@kaynooo/kayjs-cms/entry-editor.kay` and `@kaynooo/kayjs-cms/entry-table.kay`.

## Building an entry screen

To arrange an entry screen in a way the layout cannot, build it from the parts the default one is made of. `createEntryForm` from `@kaynooo/kayjs-cms/form` keeps the state: drafts, save, publish, delete, reset and the warning when you leave with edits. Each part takes that `form`.

```kay
---
import type { ScreenCollection, StoredEntry } from '@kaynooo/kayjs-cms'
import EntryActions from '@kaynooo/kayjs-cms/entry-actions.kay'
import EntryField from '@kaynooo/kayjs-cms/entry-field.kay'
import EntryHeader from '@kaynooo/kayjs-cms/entry-header.kay'
import EntryIdentity from '@kaynooo/kayjs-cms/entry-identity.kay'
import EntryNotices from '@kaynooo/kayjs-cms/entry-notices.kay'
import { createEntryForm } from '@kaynooo/kayjs-cms/form'

const { prefix, collection, entry } = props<{ prefix: string, collection: ScreenCollection, entry?: StoredEntry | undefined }>()

const form = createEntryForm({ prefix, collection, entry })
---
form(novalidate onSubmit={event => { event.preventDefault(); void form.save() }})
  EntryHeader(prefix={prefix} collection={collection} title={form.name} subtitle={form.subtitle})
    EntryActions(form={form})
  EntryIdentity(form={form})
  EntryNotices(form={form})
  EntryField(form={form} name="photo")
  EntryField(form={form} name="name")
```

`EntryField` renders one field by its key in the schema, and throws for a key the schema lacks. `EntryBody` renders the Markdown body and `EntryFields` renders everything as the layout arranges it. `EntryNotices` shows a file that does not parse, a refused save with its Keep my edits button, and the messages of any field the screen does not render. Saves, conflicts, uploads and messages work as on the default screen, and the words come from the same `cms.*` keys.

An island marked `persist` keeps its state when the page refreshes in place and takes new props. Give it `entry: () => all.entry`, with `all` being what `props()` returned, and the title, the slug and the file's problem follow the refreshed entry.

## In the dev tool

Under `kay dev`, the dev tool has a CMS tab with nothing to set up. It says whether you are in edit mode. One button takes you into edit mode on the page you are viewing, as long as the guard lets you in, and another leaves it.

<ReadMore href="/llms/kayjs-cms">Every option, the CMS API and the rules that are easy to get wrong are in the full kayjs-cms reference.</ReadMore>
