---
title: kayjs-cms
order: 4
description: Edit a kay site's content on the page it renders, and manage each collection from screens generated from its schema.
---
`@kaynooo/kayjs-cms` edits a kay site's [content collections](/guides/content) in two ways. Edit mode opens the real page: click a title, edit it in a sidebar, and the page updates as you type. The screens, generated from each collection's schema, list, search, add, edit, publish and delete entries.

Both save the same way. A file entry is a Forgejo commit, or a change in the working tree under `kay dev`. A loaded entry goes through its collection's loader.

## Install

```sh
bun add @kaynooo/kayjs-cms @iconify-json/tabler
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

The screens live at `/admin`. Set `prefix` to move them. They stay closed without a `guard`.

`guard` also takes the built guard itself, `auth.guard({ require: 'editor' })`. Then `kay.config.ts` imports `./src/auth`, and with it the app's database, for every `kay build` and `kay check`.

## Edit mode

In edit mode, kay renders the editor at the end of every page, with the entries the page read. The "Edit on page" links on the screens put an editor the guard admitted in edit mode. The editor's "Stop editing" button leaves it.

Once there is a guard, every save needs it, edit mode included, as an edit cookie or link is tied to no user. With a guard, `author` names who a save is committed as, such as the signed-in user.

## Collection titles

The screens title a collection with its export's name, humanized: `blogPosts` shows as "Blog posts". A collection can say its own title with the `title` option, which suits a site that is not in English:

```ts
export const produits = collection('src/content/produits', { schema, title: 'Produits' })
```

The name keeps naming the collection's URL, its markers and its upload folder.

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

An array field is a list of items, each with a button to remove it. Up and down buttons beside an item move it, and Alt with the up or down arrow does the same from inside its fields. The order saved is the order shown.

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

An image or file field (`imageField()`, `fileField()` from `kay/content`) takes a file dropped or picked. It is stored through kay's [file storage](/guides/file-storage), and the field keeps the path that serves it. The path stays behind a collapsed Path control under the preview, for an editor who would rather type one.

An image pasted or dropped into a Markdown body is uploaded the same way and embedded where the cursor is. A refused upload shows a message and leaves the text as it was.

A file field takes PNG, JPEG, WebP, GIF, AVIF and PDF files. Set `uploads` to list others, such as `['image/*', 'application/pdf']`. The file picker offers only those types, and a file over the size limit or of another type is refused with its type or size in the message, an empty one too.

An upload may weigh 20 MB by default. `uploads: { types, maxSize }` sets either, `maxSize` in bytes or as a string such as `'50mb'`, for a site of videos or large PDFs, or `'2mb'` for a portfolio that wants less; a part left out keeps its default.

The upload route takes `maxSize` whatever the app's `bodyLimit` is, so nothing else is raised. The editor refuses an oversized file before sending it, and the server stays the one that decides. A size that is zero, negative, not a whole number of bytes or over 128 MB less 64 KB stops `kay.config.ts` from loading: Bun refuses a request body over 128 MB before the route sees it, and the upload is buffered in memory.

`pageSize` sets how many entries a collection's list shows on a page, 50 by default.

Replacing or removing a file leaves the old upload stored. The unused-uploads screen at `<prefix>/uploads` lists the uploads no entry mentions, and deletes only the ones you confirm, and only with a `guard`.

Check each upload before you confirm. A URL written by hand in a page, or a file outside the collections, is not seen as a use.

<ReadMore href="/llms/kayjs-cms">Which uploads the unused-uploads screen holds back, and when it lists nothing.</ReadMore>

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

A folder entry is a file, and `files` says where it goes. `forgejo()` commits it. `workingTree()` writes it in place, which is the default under `kay dev`.

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

## Saves and conflicts

A commit shows on the site once it has rebuilt from it. The Forgejo token needs write access to the repository's contents, and the commit is the token's user's.

A save or a delete made over another save is refused rather than writing over it. So is one made over your own save before the site rebuilt from it. The refusal stays on the form, and its Keep my edits button lets the next save write your edits over that save.

A save that takes over 15 seconds (`timeout`), or a forge out of reach, fails with the reason. It says so when the commit may still have gone through.

A repository checked out with CRLF line endings, or using SHA-256 object names, gives files another version than the editor computes, so every save conflicts.

## Arranging a collection

The screens read each collection's schema. To change how one looks, name it in `cms({ collections })`:

```ts
cms({ collections: { shop: {
  form: { fields: ['price', ['stock', 'live'], 'photo'], hide: ['sku'] },
  list: { columns: ['price', 'live'], actions: ['delete'] },
} } })
```

In the form, `fields` come first, in that order. A list inside it is a row of columns, which stack where there is no room. The other fields follow in the schema's order, then the Markdown body, which you name `body`. `hide` leaves a field out. A hidden field that a save refuses still shows its message above the form.

In the list, `columns` are field keys shown after the title, and `actions` keeps some of a row's `move`, `publish`, `editOnPage` and `delete`. A list, group, JSON or custom field cannot be a column.

The editor on the page follows the form's layout too. A name twice, or an action that does not exist, throws when `kay.config.ts` loads. A field the schema lacks logs a warning at boot.

## Replacing a screen

Write a page at the screen's path, such as `src/routes/admin/collections/shop/[...slug].kay`. It replaces that screen and leaves the others. A `src/routes/admin/_layout.kay` replaces the cms's own layout for all of them, which holds the Content link, the toaster, the tooltip host and the stylesheet `@kaynooo/kayjs-cms/admin.css`. Render kayjs-ui's `Toaster` and `TooltipHost` and import that stylesheet to keep them. The cms guard still runs before your page.

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

## In the dev tool

Under `kay dev`, the dev tool has a CMS tab with nothing to set up. It says whether you are in edit mode. One button takes you into edit mode on the page you are viewing, as long as the guard lets you in, and another leaves it.

<ReadMore href="/llms/kayjs-cms">Every option, the CMS API and the rules that are easy to get wrong are in the full kayjs-cms reference.</ReadMore>
