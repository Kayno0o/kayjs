# What's new

What each release of kay and its libraries adds, newest first, each feature with where it is documented. kay and its libraries share one version, so one section covers them all; what a release breaks is in [Upgrading](upgrading.md).

## 1.71.0

- kayjs-auth `requireUser({ bare: true })` answers the user without `providers` and reads none, which kayjs-cms's `role` guard now uses ([Setup](../packages/auth/llms/setup.md)).
- A link whose page the server does not answer within 10 seconds is loaded by the browser, and a view transition stuck for 3 seconds is skipped, instead of leaving the click pending ([Navigation](navigation.md)).
- A link whose page the server does not answer within 10 seconds is loaded by the browser, and a view transition stuck for 3 seconds is skipped, and a link clicked during a transition is followed, instead of leaving the click pending ([Navigation](navigation.md)).
- A link whose page the server does not send within 10 seconds is loaded by the browser, and a view transition stuck for 3 seconds is skipped, instead of leaving the click pending ([Navigation](navigation.md)).
- A link clicked during a view transition skips it and is followed, instead of being ignored ([Navigation](navigation.md)).
- A `refresh()` landing during a link, `navigate()` or Back no longer cancels it: it waits for the swap and is dropped when the swap changed the URL, so an island polling an action needs no `{ refresh: false }` ([Navigation](navigation.md)).
- kayjs-cms's entry screen swaps its form for a notice linking the collection, the renamed entry or the created one when a leave after a delete, a rename or a create is declined, and `createEntryForm` returns `stranded` ([Screens](../packages/cms/llms/screens.md)).
- `navigate()` resolves to `false` when a leave guard was declined and the page stayed, `true` otherwise ([Navigation](navigation.md)).
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
