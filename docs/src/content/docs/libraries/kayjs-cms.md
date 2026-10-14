---
title: kayjs-cms
order: 4
description: Edit a kay site's content on the page it renders, and manage each collection from screens generated from its schema.
---
`@kaynooo/kayjs-cms` opens the real page in edit mode: click a title, edit it in a sidebar, and the page updates as you type. Its screens, generated from each collection's schema, list, search, add, edit, publish and delete entries. Both save the same way: a file entry as a Forgejo commit, or in the working tree under `kay dev`, and a loaded entry through its collection's loader.

## Install

```sh
bun add @kaynooo/kayjs-cms @iconify-json/tabler
```

The `@kaynooo` scope must point at the Forgejo registry in your `.npmrc` (a project made by `kay new` has it). kay and kayjs-ui are peers: the editor is drawn with kayjs-ui, so the app imports its theme. It is released with kay, at kay's own version, and peers on kay's minor: install the one matching your kay, and move them together. An app on a `^0.x` range moves to kay's version by hand, as a caret on 0.x never reaches it.

## Setup

`cms()` goes in `kay.config.ts`'s `extensions`:

```ts
import { cms, forgejo } from '@kaynooo/kayjs-cms'
import { defineConfig } from 'kay/server'
import { auth } from './src/auth'

export default defineConfig({
  extensions: [cms({
    // Who may use the screens and save; edit mode alone only reads.
    guard: auth.guard({ require: 'editor' }),
    // Left out, a file entry is written in the working tree, for `kay dev`: a production server refuses to boot so.
    files: process.env.FORGEJO_TOKEN ? forgejo({ url: 'https://git.example.com', repo: 'me/site', token: process.env.FORGEJO_TOKEN }) : undefined,
  })],
  // Edit mode is kay's preview mode: it needs the secret signing its cookie.
  preview: { secret: process.env.PREVIEW_SECRET },
})
```

The screens live at `/admin` (`prefix` moves them) and stay closed without a `guard`. In edit mode, kay renders the editor at the end of every page, with the entries the page read; "Edit on page" links on the screens put an editor the guard admitted in edit mode, and the editor's "Stop editing" button leaves it. Once there is a guard, every save needs it, edit mode included: an edit cookie or link is tied to no user. With a guard, `author` names who a save is committed as, such as the signed-in user.

A file field takes PNG, JPEG, WebP, GIF, AVIF and PDF files unless `uploads` lists others (`['image/*', 'application/pdf']`). A body whose Markdown renders HTML that would run as the site or cover it, a `<script>`, an `onclick`, a `style`, a `javascript:` link, or a tag left open for the page around it to close, is refused on save unless `rawHtml` lists the collection; the collection's own components and HTML shown in a code block are fine.

A commit shows on the site once it has rebuilt from it. A save or a delete made over another save, or over one's own before the site rebuilt from it, is refused rather than writing over it: the refusal stays on the form, and its Keep my edits button lets the next save write the edits over that save. A save taking over 15 seconds (`timeout`) or a forge out of reach fails with the reason, saying so when the commit may still have gone through. A repository checked out with CRLF line endings, or using SHA-256 object names, gives files another version than the editor computes, so every save conflicts. The Forgejo token needs write access to the repository's contents, and the commit is the token's user's. An image or file field (`imageField()`, `fileField()` from `kay/content`) takes a file dropped or picked, stored through kay's [file storage](/guides/file-storage), and keeps the path that serves it.

An app replaces a screen by writing a page at its path, `src/routes/admin/new/[collection].kay` say, and can render the screens' own `@kaynooo/kayjs-cms/entry-editor.kay` and `@kaynooo/kayjs-cms/entry-table.kay` in it.

<ReadMore href="/llms/kayjs-cms">Every option, the CMS API and the rules that are easy to get wrong are in the full kayjs-cms reference.</ReadMore>
