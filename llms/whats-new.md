# What's new

What each release of kay and its libraries adds, newest first, each feature with where it is documented. kay and its libraries share one version, so one section covers them all; what a release breaks is in [Upgrading](upgrading.md).

## Unreleased

- A tree-sitter grammar for `.kay` files colours them in Neovim, Helix and Zed, and a Zed extension starts the language server ([Check and tools](check-and-tools.md))
- kayjs-mail runs a mailing list with `mail.list()`: a subscribe form with double opt-in, signed one-click unsubscribe links and headers, paced sending through the queue that resumes after a restart, and `mail.erase(address)` ([A mailing list](../packages/mail/llms/mailing-list.md)).
- `cms({ newsletter })` lets an editor preview an entry as a list mail, test it to their own address and send it to a kayjs-mail list from the entry screen ([Sending an entry to a mailing list](../packages/cms/llms/newsletter.md))
- `metrics: true` serves `/metrics` for Prometheus: requests by route and status, durations, job runs, cache reads and live connections, read only from the machine or a private network, or with a bearer `KAY_METRICS_TOKEN` ([Metrics for a collector](production.md#metrics-for-a-collector)).
- `kay/test/preload` keeps a variable an earlier preload pinned, so `preload = ["./tests/setup.ts", "kay/test/preload"]` reaches the modules `kay.config.ts` imports ([Test setup](testing-setup.md)).
- kayjs-ui Avatar, Stat, PageHeader, PageSection, EmptyState, CardRow, Widget, Meter, Progress and Skeleton draw their look in recipe utilities too, and their part classes are gone (`deprecated-ui-class`, [Setup](../packages/ui/llms/setup.md)).
- kayjs-auth `ImpersonationBanner` shows in any layout or component with no fence, in the first bytes, reading the new `ctx.impersonator` ([The signed-in user in templates](../packages/auth/llms/signed-in-components.md#show-the-impersonation-banner)).
- `src/ui.ts` adds a variant or a value a component's recipe lacks, `Badge: { variants: { tone: { brand: { root: 'bg-brand' } } } }` makes `Badge(tone="brand")` valid and completed ([Restyle a component from src/ui.ts](styles-and-assets.md#restyle-a-component-from-srcuits)).
- `src/ui.ts` keys a component by the name a template calls it, `defineUi({ Card: { parts: { head: 'p-6' } } })`, and `defineUi` is typed per component from `.kay/types/kay-ui.d.ts` ([Restyle a component from src/ui.ts](styles-and-assets.md#restyle-a-component-from-srcuits)).
- `mountComponent` names the island and the imports down to the server module a browser cannot take, as `kay build` does, and the error says an island cannot import a server module ([Browser-only components](browser-only.md#browser-only-components)).
- `markdownHtml` from `kay/markdown` loads marked in an island on its first call instead of with the island, showing the text as written until it arrives, which takes about 17 KB gzip off every chat island ([Content](content.md)).
- A page whose islands use no `for`, `await`, `try` or spread ships about 1.4 KB less JS: the code of each block loads only with the islands compiled to it ([Build and start](build-and-start.md#build-and-start-commands)).
- kayjs-auth serves organization pages in the account area (members, roles, invitations) and an invitation page that invitation mails open by default, with no declaration beyond `organizations` ([Organization pages](../packages/auth/llms/organization-pages.md)).

## 1.71.0

- kayjs-auth `requireUser({ bare: true })` answers the user without `providers` and reads none, which kayjs-cms's `role` guard now uses ([Setup](../packages/auth/llms/setup.md)).
- A link whose page the server does not answer within 10 seconds is loaded by the browser, and a view transition stuck for 3 seconds is skipped, instead of leaving the click pending ([Navigation](navigation-from-code.md)).
- A link whose page the server does not answer within 10 seconds is loaded by the browser, and a view transition stuck for 3 seconds is skipped, and a link clicked during a transition is followed, instead of leaving the click pending ([Navigation](navigation-from-code.md)).
- A link whose page the server does not send within 10 seconds is loaded by the browser, and a view transition stuck for 3 seconds is skipped, instead of leaving the click pending ([Navigation](navigation-from-code.md)).
- A link clicked during a view transition skips it and is followed, instead of being ignored ([Navigation](navigation-from-code.md)).
- A `refresh()` landing during a link, `navigate()` or Back no longer cancels it: it waits for the swap and is dropped when the swap changed the URL, so an island polling an action needs no `{ refresh: false }` ([Navigation](navigation-from-code.md)).
- A server started from disk imports the modules `kay build` recorded in `.kay/client/server-modules.json` and loads no compiler at boot ([Build and start](build-and-start.md)).
- kayjs-cms's entry screen swaps its form for a notice linking the collection, the renamed entry or the created one when a leave after a delete, a rename or a create is declined, and `createEntryForm` returns `stranded` ([Screens](../packages/cms/llms/screens-replacing.md)).
- `navigate()` resolves to `false` when a leave guard was declined and the page stayed, `true` otherwise ([Navigation](navigation-from-code.md)).
- kayjs-ui's `ConfirmDelete` takes `disabled`, which disables its trigger and confirm button while the caller is busy and keeps an open dialog open ([Dialogs](../packages/ui/llms/basics.md)).
- kayjs-ui's `IconButton` and `BareIconButton` take `href` and render a link with the same look, parts and tooltip ([Basics](../packages/ui/llms/basics.md)).
- kayjs-ui `SidePanel(modal={false})` shows a detail beside a live view, the page under it staying interactive, and `closeHref` makes its close button a link for a panel the URL drives ([Page layout](../packages/ui/llms/page-layout-palette-and-trees.md)).
- kayjs-ui gains radius steps (`--radius-kui-sm`, `-md`, `-full`), font tokens (`--font-kui-mono`, `--font-kui-body`) and `--kui-density`, which scales the spacing tokens ([Setup](../packages/ui/llms/setup.md)).
- kayjs-ui `Slider` takes `onChange(value)` once on release or key press, a promise holding it busy and `false` putting the thumb back ([Slider](../packages/ui/llms/forms.md)).
- `unsized-image` no longer warns of an `img` whose static classes or `style` reserve its box, as `aspect-video w-full` ([Checks](checks.md)).
- kayjs-ui `ColorInput` picks a `#rrggbb` colour on a native input drawn as a swatch, holds itself busy on a promise from `onChange` and puts the colour back when refused ([Forms](../packages/ui/llms/forms.md)).
- kayjs-ui `ColorInput` and `Slider` take an `aria-label` naming the input in place of `label`, and keep a `value` the parent set onto a refused change ([Forms](../packages/ui/llms/forms.md)).
- kayjs-ui `ChipGroup` takes number values as `Segmented` does, and `Segmented`, `ChipGroup` and `RadioGroup` take `disabled` for the whole group ([ChipGroup](../packages/ui/llms/tables-navigation-and-layout.md)).
- `pgData` replicas hear room messages, invalidations and live values in the order they were made, also when their ids gain a digit, where a message could arrive before an earlier one and twice ([Rooms](rooms.md)).
- `pgData` replicas hear room messages, invalidations and live values in the order they were made, also when their ids gain a digit, where a message could arrive before an earlier one, or twice ([Rooms](rooms.md)).
- A test page load that meets `net::ERR_NETWORK_CHANGED`, the host's network changing under it, is navigated again once ([Browser tests](testing-browser.md)).
- A test page load that meets `net::ERR_NETWORK_CHANGED`, the host's network changing under it, is navigated again once, as is a reload ([Browser tests](testing-browser.md)).
- The on-page editor offers Publish, Unpublish and Delete for the entry beside Save, with the role's refusal as tooltip ([Editor](../packages/cms/llms/editor.md)).
- `proxy: { key: 'x-upstream-key' }` refuses with 403 every request lacking the key the proxy shares (`KAY_PROXY_KEY` or `KAY_PROXY_KEY_FILE`), with the health route and `open` paths left out ([Proxies](proxy-and-security.md#behind-a-proxy)).
- `rooms({ store: appStore().rooms })` is typed `StoreRooms`, whose `state` and `update` give the state or a promise of it, so `await` them with no narrowing ([Rooms](rooms.md)).
- A template reads request values with no fence, `ctx.user` and `ctx.can('admin')` from kayjs-auth, which an extension gives with `context: file` and `defineContext`; only pages reaching a template reading `ctx` load them, in the first bytes ([Request values](request-values.md)).
- `defineContext({ cartCount: request => ... })` gives `ctx` one loader per key, run once per request and only for pages whose templates read that key, and the walk finding those pages follows aliases, `import()` and `import.meta.glob` as islands are found ([Request values](request-values.md)).
- kayjs-auth switches features off with one key each in `auth({ password: false, passkeys: false, magicLink: false, twoFactor: false })`; their methods answer `off` and the pages show none of it ([Switching features off](../packages/auth/llms/oauth-passkeys-two-factor.md#switching-features-off)).
- kayjs-auth's `SignedIn`, `SignedOut` and `UserMenu` show the user in the first bytes with no `viewer: true`: a page reads the session only when its imports reach one of them, and an extension's `layout: { file, reaching }` wraps only the pages reaching its files ([Templates](../packages/auth/llms/signed-in-components.md), [Extensions](component-libraries.md#extensions)).
- kayjs-ui Card, Badge and Notice draw their look in recipe utilities, so `src/ui.ts` replaces a value instead of fighting a rule; their part classes are gone (`deprecated-ui-class`, [Setup](../packages/ui/llms/setup.md)).
- `auth()` mails in kayjs-mail's wording from an executable too, as an extension's `server` now receives `extensions`, the names the config lists ([Extensions](component-libraries.md#extensions)).
- kayjs-ui ships a `space` skin, `@kaynooo/kayjs-ui/skins/space.css`: dark only, starlight accent, keys, drawn checkboxes, themed selects and a `starfield` utility ([Setup](../packages/ui/llms/setup.md)).
- kayjs-ui labels take `--kui-label-case` and `--kui-label-font`, and two skins ship: `@kaynooo/kayjs-ui/skins/brutalist.css` and `soft.css` ([Setup](../packages/ui/llms/setup.md)).
- An extension names optional app files with `appFiles: { hooks: 'src/auth.ts' }` and gets their modules in `server({ root, modules })`: kay bakes them into `kay build --compile` and reloads them under `kay dev`, so `auth()` reads `src/auth.ts` and `src/mail.ts` in an executable too ([Extensions](component-libraries.md#extensions)).
- kayjs-auth serves admin pages (users with search, roles, bans, impersonation, audit log) behind its `admin` option, and an impersonation banner with the way back ([Admin pages](../packages/auth/llms/admin-pages.md)).
- `kay add auth` and `kay new --with auth` write the one line `auth({ name })` and a root `_guard.ts` exporting kayjs-auth's `guard()`, with no `src/auth.ts`, and `authTest(site)` from `@kaynooo/kayjs-auth/test` signs a test site in without a module ([kayjs-auth setup](../packages/auth/llms/setup.md#setup)).
- With `ui()`, `@apply` of a `kui-*` utility in the app's stylesheet needs no `@reference` line: an extension's `references` gives its stylesheets the tokens ([Setup](../packages/ui/llms/setup.md), [Extensions](component-libraries.md#extensions)).
- A browser test opens a page at a phone size with `viewport: 'phone'`, and hovers or clicks at a point of an element, a canvas say, with `at: { x, y }` ([Browser tests](testing-browser.md)).
- A handler of an API module names its own routes with `apiUrl(request, path)`, with no reference to the module inside its own chain ([API modules](api-routes.md)).
- `call.track(module, path)` gives an API route's calls an action `track()`'s result, `{ ok, status, errors, data }` instead of a throw ([API from islands](api-from-islands.md)).
- An action's third argument groups its checks under `protect: { rateLimit, honeypot, minTime, proofOfWork }`, beside `maxSize`, `messages` and `tool` ([Protecting actions](action-protection.md#protecting-an-action)).
- `store: sqliteData(path)` also shares every `live()` value between processes and keeps it across restarts ([Live values](live-values.md)).
- kayjs-ai's `Chat` and `ChatLauncher` draw their icons from kayjs-ui's icon slots (new: `chat`, `send`, `stop`, `expand`, `collapse`), so an app's `settings.icons` changes them ([Chat](../packages/ai/llms/chat.md)).
- Editor completion offers the props of a package's component and of a props type imported from another file, and renaming a `.kay` file updates the TypeScript modules importing it ([Editor](editor-and-agent-commands.md)).
- The language server links a relative import to the file it names, and a rename or move also updates the imports in a `--- module` fence ([Editor](editor-and-agent-commands.md)).
- `--- style` holds CSS scoped to the component, nested rules and `@apply` included, with `:global()` as the escape, and goes through the per-page cut like an imported stylesheet ([Components](components.md#file-layout)).
- `apiPath: '/v1'` in `kay.config.ts` moves every API module, the OpenAPI document and the reference page off `/api`, and islands, the service worker, prefetching and kayjs-cms follow ([API modules](api-routes.md#api-modules)).

The rest of this release is in [What's new, older releases](whats-new-archive.md).

Releases before 1.71 are in [What's new, older releases](whats-new-archive.md).
