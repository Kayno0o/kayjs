# kayjs-cms

A CMS for kay sites, in the spirit of TinaCMS: open the real page in edit mode, click a title, edit it in a sidebar, and the page updates as you type. The same package holds collection screens, generated from each collection's schema, to list, search, add, edit, publish and delete entries. Both save the same way: a file entry as a Forgejo commit, or in the working tree under `kay dev`, and a loaded entry through its collection's loader.

kay's side of it is kaynooo/kayjs#262; the plan is kaynooo/kayjs-cms#1.

## Install

kayjs-cms is published to the Forgejo registry at git.kaynooo.fr, beside kay. Tell Bun where the `@kaynooo` scope lives once, in `~/.bunfig.toml`:

```toml
[install.scopes]
"@kaynooo" = "https://git.kaynooo.fr/api/packages/kaynooo/npm/"
```

```sh
bun add @kaynooo/kayjs-cms @iconify-json/tabler
```

kay is a peer. The editor is drawn with kayjs-ui, so the app imports its theme as kayjs-ui's README says. kayjs-ui is a peer dependency, so the app and the CMS share one copy: the screens and the editor render their own `Toaster` and `TooltipHost`, which give way to the app's when it renders them.

## Set up

```ts
// kay.config.ts
import { auth } from './src/auth'
import { cms, forgejo } from '@kaynooo/kayjs-cms'
import { defineConfig } from 'kay/server'

export default defineConfig({
  extensions: [cms({
    // Who may use the screens, and the API outside edit mode.
    guard: auth.guard({ require: 'editor' }),
    // Left out, a file entry is written in the working tree, for `kay dev`.
    files: process.env.FORGEJO_TOKEN ? forgejo({ url: 'https://git.example.com', repo: 'me/site', token: process.env.FORGEJO_TOKEN }) : undefined,
  })],
  // Edit mode is kay's preview mode: it needs the secret signing its cookie.
  preview: { secret: process.env.PREVIEW_SECRET },
})
```

The screens live at `/admin` (`prefix` moves them) and stay closed without a `guard`. In edit mode, kay renders the editor at the end of every page, with the entries the page read. The CMS's API answers requests kay let into edit mode, and those the guard admits. Their "Edit on page" links go through `/admin/page?path=`, which puts the editor the guard admitted in edit mode with kay's `enterPreview(ctx, { edit: true })`.

A commit shows on the site once it has rebuilt from it. The Forgejo token needs write access to the repository's contents; the commit is the token's user's. The server reads a folder collection's entries from its source files, so they ship with it: kay refuses to edit a folder missing from a build alone, or lying outside the repository.

An image or file field (`imageField()`, `fileField()` from `kay/content`) takes a file dropped or picked, stored through kay's file storage, and keeps the path that serves it, so a page renders it as `img(src={entry.data.photo})`; a path typed in works too. kay keeps files in `data/files` by default: a deployed site sets `storage` in kay.config.ts to an S3 store or a disk that outlives a deploy.

An app replaces a screen by writing a page at its path, `src/routes/admin/new/[collection].kay` say, and can render the screens' own `@kaynooo/kayjs-cms/entry-editor.kay` and `@kaynooo/kayjs-cms/entry-table.kay` in it.

## Develop

```sh
bun install
bun run lint
bun run check
bun run test
```

`tests/fixture` is an app installing the package through a link, which `kay check` and `testSite` run against. See `llms.txt` for the API.
