# What's new, older releases

What each release before 1.71 added, and the end of a newest release that was cut short (`(continued)`), newest first, each feature with where it is documented. The newer releases are in [What's new](whats-new.md); what a release breaks is in [Upgrading](upgrading.md).

## 1.71.0 (continued)

- `store: pgData(db)` in kay.config.ts keeps the sessions, `cached` values, `live()` values, jobs, rate counts, presence members and Web Vitals in Postgres for replicas on several machines, as `sqliteData(path)` does in a file, and `rooms({ store: pgData(db).rooms, state })` keeps a room's state there with `state` and `update` answering promises ([Queues](queues.md), [Rooms](rooms.md)).
- A server entry no longer calls `listen`: `kay dev`, `kay start` and the executable listen it on `PORT` and `HOST` ([Build and start](build-and-start.md)).
- A component call can hand several parts on, `Busy(part="root spinner")`, so a Button with an `onClick` takes the `spinner` part ([Styling](../llms/styles-and-assets.md)).
- kayjs-ui `Accordion`, `Skeleton`, `Progress`, `Breadcrumb`, `RadioGroup` and the MarkdownEditor preview take parts that `src/ui.ts` restyles ([Setup](../packages/ui/llms/setup.md)).
- kayjs-ui's `IconButton` takes a snippet for its `icon`, `BareIconButton` draws a button around your own `svg`, and `Textarea` takes `writeFocused` ([Forms](../packages/ui/llms/forms.md)).
- kayjs-ui has a `BarChart`: vertical bars over a time or category axis in plain HTML, coloured from their status, stackable ([BarChart](../packages/ui/llms/charts-drag-and-media.md)).
- A `.kay` file that does not compile fails only the `testSite()` visit of the pages importing it, with the error naming the file ([Test site](testing.md#test-site)).
- `apiUrl(module, path)` gives an API route's URL under the configured `apiPath` ([API modules](api-routes.md#api-modules)).
- Each `src/plugins/<name>.ts` default-exporting an Elysia plugin is used before the pages in file-name order and types `ctx.locals`, so no `src/server.ts` is needed ([Mount a server plugin](server.md#mount-a-server-plugin)).
- `collection(..., { route: '/blog/:slug' })` gives each entry a typed `url`, a feed item links it, and `kay check` reports a route no page serves ([Give each entry its page's path](content.md#give-each-entry-its-pages-path)).
- A collection `route` is also read by the CMS, by `alternate()`, by the locale rule for a dotted slug such as `v1.2`, and by `kay check` against the page prerendering it ([Give each entry its page's path](content.md#give-each-entry-its-pages-path)).
- `cache(load, { ttl, tags })` and `cacheTag()` from `kay/cache` cache a function with a key from its module and name, `.invalidate()` and tags to drop a group ([Cache a function with no key to type](rendering.md#cache-a-function-with-no-key-to-type)).
- `import.meta.glob('~icons/game-icons/{war-pick,axe-swing}', { eager: true, import: 'default' })` bundles just the icons it names ([Icons](images.md#icons)).
- An action declared in a page types `ctx.params` from that page's route ([Actions](actions.md#declaring-an-action)); a guard's and a layout's stay `unknown`.
- A class held in data, such as `color: 'text-blue-200'` in rows or a JSON file, keeps its rule on the page with no warning and no `@source inline` ([Styles and assets](styles-and-assets.md)).
- `bind:group` on radios and checkboxes, `bind:open` on `details` and `dialog`, `bind:files` on file inputs, and a `ref` returning a cleanup ([Templates](templates.md)).
- `style:prop={value}` sets one CSS property, and `onSubmit|preventDefault={save}` calls `preventDefault` or `stopPropagation` first ([Templates](templates.md)).
- The language server completes element, attribute, prop and block names, route paths, `t()` keys and lint names, and offers an outline, folding, fix-all-on-save and import updates on rename ([Editor](editor-and-agent-commands.md)).
- `kay check` warns of a static component rendering as an island (`promoted-island`), `// kay-island` and `// kay-static` mark intent (`island-marker`), and the editor shows a lens ([Islands](islands.md#islands)).
- A `--- module` fence holds module-level code whose exports other files import, typed ([Components](components.md#file-layout)).
- The VS Code extension `kaynooo.kay` is on the Marketplace and Open VSX and attached to each release as a `.vsix`; `kay new` recommends it and formats `.kay` on save ([Serve an editor](editor-and-agent-commands.md#serve-an-editor)).
- `kay check --watch` checks a change to `.kay` files alone in its own process, and `kay check` types the project while it reads the collections, both faster ([Check and tools](check-and-tools.md)).
- `kay dev` type-checks the project beside the server after each change, its errors in the Problems tab, `.kay/dev/errors.json` and the terminal, `--no-types` turns it off ([kay dev](dev-server.md)).
- `kay fmt --stdin [path]` formats a source from stdin, with Neovim, Helix and Zed setups ([Format the templates](check-and-tools.md#format-the-templates)).
- A browser error's stack under `kay dev` is on `.kay` lines in `.kay/dev/errors.json` and the Problems tab ([Errors without a browser](dev-server.md)).
- The language server checks the edited component first as you type, then the open components importing it after a quiet spell, so many open files no longer slow each edit.
- `kay generate page|component|island|action|api|guard <name>` writes a starter file, with a test when the project has tests, and `kay generate resource post title:string body:text [--dir app] [--plural posts]` a pg-orm table, list, edit and create pages, actions and a test ([kay generate](project-new-and-add.md)).
- `store: sqliteData(path)` in kay.config.ts also keeps the data of every `session()` and `cached` naming no store of their own ([Keep a session](server.md#keep-a-session), [Stores](rendering.md#stores)).
- kayjs-auth has `SignedIn`, `SignedOut` and `UserMenu` components that show the signed-in user and their roles from any template with no server fence, and `auth({ viewer: true })` loads the user before the page renders ([Templates](../packages/auth/llms/signed-in-components.md)).
- `auth({ oauth: { github: true }, roles })` in `kay.config.ts` is the whole kayjs-auth setup: the session, site, store (SQLite, or `KAYJS_AUTH_DATABASE_URL`), mailer (`src/mail.ts`), OAuth credentials (`GITHUB_CLIENT_ID`) and hooks (`src/auth.ts` exporting `hooks`) are found, with no `createAuth` module ([kayjs-auth setup](../packages/auth/llms/setup.md#setup)).
- `apiPath: '/v1'` in `kay.config.ts` moves every API module, the OpenAPI document and the reference page off `/api`, islands, the service worker, prefetching and kayjs-cms follow it, and `apiUrl(module, path)` gives a route's URL ([API modules](api-routes.md#api-modules)).
- kayjs-cms is served under `/_kay/cms` whatever `apiPath` is, the old `/api/cms` answering through 1.73, and kayjs-auth's tables are `kay_*`, renamed by `db.sync()` or the generated migration ([upgrading](upgrading.md)); `api.prefix` of an extension takes a `/_kay/` path and `api.former` the old one ([Component libraries](component-libraries.md)).
- `apiPath: '/v1'` in `kay.config.ts` moves every API module, the OpenAPI document and the reference page off `/api`, islands, the service worker and prefetching follow it, and `apiUrl(module, path)` gives a route's URL ([API modules](api-routes.md#api-modules)).
- Each `src/plugins/<name>.ts` default-exporting an Elysia plugin is used before the pages, in the order of the file names, and types `ctx.locals`, so sessions, jobs and derives need no `src/server.ts` ([Mount a server plugin](server.md#mount-a-server-plugin)).
- `collection(..., { route: '/blog/:slug' })` gives each entry a typed `url`, a feed item with no `path` links it, and `kay check` reports a route no page serves ([Give each entry its page's path](content.md#give-each-entry-its-pages-path)).
- A collection `route` is read by the CMS, by `alternate()` on a page that read the entry (its translation's own url), by the locale rule for a dotted slug such as `v1.2`, and by `kay check` against the page prerendering it ([Give each entry its page's path](content.md#give-each-entry-its-pages-path)).
- `cache(load, { ttl, tags })` and `cacheTag()` from `kay/cache` give a cached function whose key comes from its module and name, with `.invalidate()` on it and tags to drop a group, so no string key can be mistyped ([Cache a function with no key to type](rendering.md#cache-a-function-with-no-key-to-type)).
- `import.meta.glob('~icons/game-icons/{war-pick,axe-swing}', { eager: true, import: 'default' })` bundles just the icons it names, for an icon known by name at runtime ([Icons](images.md#icons)).
- An action declared in a page types `ctx.params` from that page's route, a matcher's value as it gives it ([Actions](actions.md#declaring-an-action)); a guard's and a layout's stay `unknown`.
- `cms({ role: 'editor' })` guards with kayjs-auth, and a production cms with no `files` commits to the Forgejo `CMS_*` names ([Options of cms()](../packages/cms/llms/options.md)).

Releases before 1.71 are in the notes of their releases, at https://git.kaynooo.fr/kaynooo/kayjs/releases.
