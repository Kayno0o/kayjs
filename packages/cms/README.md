# kayjs-cms

A CMS for kay sites, in the spirit of TinaCMS: open the real page in edit mode, click a title, edit it in a sidebar, and the page updates as you type. The same package will hold the collection screens (list, add, delete, publish), saving file content as a Forgejo commit and loader content through the collection's loader.

Work in progress: kay's side of the on-page editing (field markers, edit mode, draft rendering, the schema and write API) is kaynooo/kayjs#262. Until it ships, `src/kay/` stubs that contract, so the editor is built and tested against it; the plan is kaynooo/kayjs-cms#1.

## Install

kayjs-cms is published to the Forgejo registry at git.kaynooo.fr, beside kay. Tell Bun where the `@kaynooo` scope lives once, in `~/.bunfig.toml`:

```toml
[install.scopes]
"@kaynooo" = "https://git.kaynooo.fr/api/packages/kaynooo/npm/"
```

```sh
bun add @kaynooo/kayjs-cms @iconify-json/tabler
```

kay is a peer. The editor is drawn with kayjs-ui, so the app imports its theme as kayjs-ui's README says.

## Set up

```ts
// kay.config.ts
import { cms } from '@kaynooo/kayjs-cms'
import { defineConfig } from 'kay/server'

export default defineConfig({ extensions: [cms()] })
```

In edit mode, kay renders the editor at the end of every page, with the entries the page read. The CMS's API answers only requests kay let into edit mode.

## Develop

```sh
bun install
bun run lint
bun run check
bun run test
```

`tests/fixture` is an app installing the package through a link, which `kay check` and `testSite` run against. See `llms.txt` for the API.
