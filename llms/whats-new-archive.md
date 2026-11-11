# What's new, older releases

What each release before 1.96 added, and the end of a newest release that was cut short (`(continued)`), newest first, each feature with where it is documented. The newer releases are in [What's new](whats-new.md); what a release breaks is in [Upgrading](upgrading.md).

## 1.95.0

- A page opens its one live connection once the islands it hydrates as it loads have all subscribed, however late their code arrives, instead of a second one when an island is slow ([live values](live-values.md)).
- kay 1.95 no longer makes a component an island for the function or block it passes one (`island-prop` is the answer, with `--- island` its fix), reads `// kay-island` and `// kay-static` as comments, and adds no import for a `kay` value or `t` used without one, which is a type error: the deprecations `promoted-island`, `island-comment` and `implicit-import` are removed ([Islands](islands.md#islands), [Every name is imported](components.md#every-name-is-imported)).
- A component exports `island = { hydrate, persist }` from its `--- module` fence for the defaults it wants wherever it is used, a parent's own `hydrate` and `persist` winning ([islands](islands.md#hydrate-an-island-later)). kayjs-ai `ChatLauncher` is an island by it, persisted and hydrating with its chat when the browser is idle; a static page or layout giving it a function or a block with parameters gets `island-prop` from `kay check`, as for any island, its fix writing `--- island`.
- An `s.Optional` env field whose `<NAME>_FILE` names a missing, unreadable or empty file is left unset with one warning naming the file, instead of stopping the boot; a required field still stops it ([environment](environment.md)).
- On Postgres (`pgData`, `pgJobs`) a write reaches the other processes at once: a job enqueued in one starts in another idle one within a second, and a live value or an `invalidate` reaches another worker's clients within a second after a quiet stretch, through `LISTEN`/`NOTIFY` (one extra connection per serving process). Polling stays as the fallback, and a database that refuses `LISTEN` keeps it alone ([jobs](queues.md))
- `requireGuards` unset now refuses (403) each page, endpoint and API module no guard covers on a site with a guard of its own, and `kay check` reports each as an `unguarded-route` error; `requireGuards: false` keeps the old behaviour ([guards](guards.md), [upgrading](upgrading.md)).
- The cookies an app sets are `HttpOnly`, `SameSite=Lax`, `Secure` over https and under the `base` with no `security.cookies` setting; `cookies: false` turns it off ([sessions](server.md#sessions), [upgrading](upgrading.md)).
- kayjs-ui's LineChart and BarChart take `marks`, events drawn as a dashed rule on the x axis with a title under the pointer and for screen readers, and a link when they have an `href` ([charts](../packages/ui/llms/charts.md)).
- kayjs-ui's LineChart and BarChart take `marks`, events drawn as a dashed rule on the x axis with a title under the pointer and for screen readers, and a link when they have an `href` or a button when given `onMark` ([charts](../packages/ui/llms/charts.md)).
- `kay dev` runs no type check after an edit that changes no type: the static text of a `.kay` template, in a file with no type error ([dev server](dev-server.md)).
- `mcp: { instructions }` is sent as the `instructions` of the MCP `initialize` answer, guidance spanning tools that a client shows its model before any tool description, and `site.mcp.initialize()` in `kay/test` reads it ([API routes](api-routes.md)).
- `sanitizeHtml` takes `lazyImages: true`, which writes `loading="lazy"` on every kept `img` that has no `loading` of its own ([templates](templates-elements-slots-snippets.md)).
- The cookies an app sets are `HttpOnly`, `SameSite=Lax`, `Secure` over https and under the `base` with no `security.cookies` setting; `cookies: false` turns it off ([sessions](server.md#sessions), [upgrading](upgrading.md)).

## Unreleased (continued)

- `kay build --static` merges its security headers into a `public/_headers` instead of leaving them out, without a header your file names ([static export](prerendering.md#static-export)).
- A loader's slug may not climb out of the site, so one such as `a/../../x` is a content problem naming its entry, not a failed export ([content from a CMS](content-cms.md)).
- `lints: { comments: { reason, file, denied } }` in kay.config.ts makes a `// kay-allow` comment need a ` -- reason`, refuses `kay-allow-file`, or keeps a lint set to `deny` out of a comment's reach; a comment it refuses is reported as `allow-refused` ([lints](lints.md#allow-a-lint-on-one-line)).
- `fetchPublic` sends the `headers` you set on a redirect hop to the same origin only; a hop to another origin keeps `accept`, `accept-language` and `user-agent`, so a credential, cookie or API key stays with its own host.
- kayjs-cms: `forgejo()`, `github()` and `gitlab()` refuse a redirect from the forge, so a renamed repository needs its new `repo` in the config, and read at most 64 KB of an error body ([setup](../packages/cms/llms/setup.md)).
- kayjs-cms: `fourEyes` refuses an approval by a person the guard cannot name, as it cannot tell them from the sender, with a new `cms.review.unnamedApproval` wording ([review](../packages/cms/llms/review.md)); a guard of your own gives `cms({ member })` to approve under it.
- kayjs-auth: asking for another address mails the address the account is leaving at once, as an `email-change-requested` notice and event, where only the confirmation told it before; and `email.confirmChange` answers `invalid` when another account takes the address in the same instant, instead of failing ([security mails](../packages/auth/llms/passwords-and-mails.md#security-mails)).
- kayjs-auth: `organizations.members` gives the others' emails only to a member who manages members ([admin and organizations](../packages/auth/llms/admin-and-organizations.md)).
- kayjs-auth: `forwardAuth`'s route asks the second factor as a sign-in does: the app's `twoFactor.require` holds there, and a session signed in with a passkey passes `requireTwoFactor` ([forward auth](../packages/auth/llms/oauth-server-and-tokens.md)).
- kayjs-auth: the consent page says a self-registered client's name was not checked, with a new `auth.consent.unverified` wording, French included ([OAuth server](../packages/auth/llms/oauth-server-and-tokens.md)).
- kayjs-cms: a share link made for an entry is a `share` line of the activity log, with the person who made it, and a new `cms.activity.share` wording ([the activity log](../packages/cms/llms/history.md)).
- kayjs-cms: a role limited by `collections` or `own` is given the titles of a collection to pick from only when it reads it or a collection it reaches has a reference field to it, and the entries named in a delete confirmation are those it may read ([roles](../packages/cms/llms/options.md)).

## 1.96.0 (continued)

- `kay lint --help` and `kay test --help` open with what kay adds, then print keslint's and `bun test`'s help; `kay test --format json` prints `{ ok, exitCode, pass, fail, skip, tests, files }` as one document with the report on stderr, `kay lint --format json` hands keslint ESLint's JSON, and `kay new --help` describes `--editor` ([commands](check-and-tools.md)).
- A call whose action redirects rejects with `ActionRedirectError` (its `location`) as the browser navigates, so `pending()` clears and `settled()` resolves, instead of never settling ([actions from islands](actions-from-islands.md)).
- A call whose action redirects rejects with `ActionRedirectError` (its `location`) once the browser has gone there, so `pending()` clears and `settled()` resolves, instead of never settling ([actions from islands](actions-from-islands.md)).
- `every`, `watch`, `listen`, `shortcut`, `guardLeave`, `followLog` and `presence` return a function that stops them before the island ends, and take `{ signal }`, an `AbortSignal` that stops them when aborted ([Effects and lifecycle](effects.md)).
- A `required` FormField and `describeField({ required })` write the native `required` as well as `aria-required`, server-rendered, and RadioGroup, Segmented, Rating, Checkbox, Toggle and ChipGroup take a typed `required` ([FormField](../packages/ui/llms/forms-and-steps.md)).
- kayjs-auth's stock register page draws a purpose line and a link to the privacy policy under the form with `pages: { privacy, purpose }`, and a production start warns when sign-up is open without `privacy` ([auth setup](../packages/auth/llms/setup.md)).
- A request an API route's or an endpoint file's guards refuse now counts against its `rateLimit`, and over the limit gets 429 in place of the refusal, so a password is no longer guessed at full speed; `basicAuth` also limits wrong credentials per client, 10 every 5 minutes, with its own `rateLimit` option (`false` turns it off) ([rate limits](rate-limits.md), [API routes](api-routes.md)).
- `localePath()`, `localize()` and `alternate()` collapse a leading `//` or `/\` of the path they get, so a language switcher on a path the visitor typed never links to another site ([locales](locales.md)).
- A YAML anchor bomb or an alias pointing at its own node in an entry's frontmatter or data file is refused as an entry problem, instead of exhausting memory at build ([content](content.md)).
- A `local()` mirror and its queue are emptied when another person signs in, not only at sign-out: kayjs-auth tags each sign-in and each start or end of an impersonation, and `forgetLocalMirrors(request, person)` does it for an app's own ([local collections](local-collections.md)).
- An effect that never settles is stopped after 1000 rounds and named in development, and the page's other effects keep running instead of staying stale ([components](components.md)).

## 1.94.0

- A link pressed while its hover prefetch was still waiting no longer fetches its page a second time, so a page is requested once per visit on a slow machine too ([navigation](navigation-from-code.md)).
- kayjs-ui's FormField, Checkbox, Toggle and FileDrop keep an empty message line out of the layout, so no row gap is left under a control and a button beside the field lines up with it; the line stays in the page to announce a message ([forms](../packages/ui/llms/forms-and-steps.md)).
- kayjs-ui's CardRow actions show at full opacity on a screen that cannot hover ([layout](../packages/ui/llms/page-layout-palette-and-trees.md)).
- kayjs-ui's MultiSelect trigger is a `combobox` button opening a dialog and takes `aria-invalid` (`invalid` or a FormField message), `aria-required` and `aria-describedby`; its `data-refused` mark is gone ([MultiSelect](../packages/ui/llms/pickers.md)).
- kayjs-ui reads one `--motion-scale` token, `0` under `prefers-reduced-motion`, for every transition it draws, the carousel, SidePanel, Badge, sortable lists and the skins included ([setup](../packages/ui/llms/setup.md)).
- `kay new --with postgres` and `kay add postgres` give each app its own development database port (derived from the app's name, in `.env`, `.env.test` and `compose.dev.yaml`) and keep its data in `data/postgres`, bind-mounted and out of git, instead of port 5433 and a named volume, and the production composes bind-mount `data-prod` (create it before the first start, owned by the container's user) instead of a named volume; the next step reads `bun run db:generate`, as pg-orm's `generate` takes no name ([project new and add](project-new-and-add.md)).
- kayjs-mail's confirmation and footer views get `site` as the site's origin and `host` as its host, and the default confirmation words name the site by its host as the subject does ([upgrading](upgrading.md)).
- The accent picker `kay new` writes sizes its popover to its seven swatches, which no longer overlap.
- Links to the current page inside an island get `aria-current` in the server HTML, as those of a page do, and an island a swap keeps (`persist`) takes the next page's marks ([navigation](navigation.md)).
- After a page swap to `/docs#install` the focus, and a screen reader's position, go to the element the fragment points at, as a page loaded natively does, the title still announced ([navigation](navigation.md)).
- A `session()` made as a module loads reads the app's secret on first use, so `secret` in `kay.config.ts` and its rotation list apply to sessions as well as `KAY_SECRET` ([the app secret](environment.md#the-app-secret)).
- `WebSocket` from `kay/server` is Bun's `WebSocket` client typed with its options, so server code opens a websocket with `headers` or `protocols` with no cast ([server](server.md)).
- An `api()` route with a `params` schema (`params: s.Object({ number: s.Integer() })`) answers over real HTTP again, as it did through `site.api`: kay hands the schema a plain copy of the route's params, which Elysia 1.4.31 could not read from Bun's; kay requires that Elysia. A path value reaches every handler decoded once, `a%2Fb` as `a/b` and `a%252Fb` as `a%2Fb`, though that Elysia writes each decoded slash as `%2F`.
- kayjs-ai keeps a reply's thinking blocks, signatures included, with the tool calls a `keepOnServer` conversation stores, and replays them with those calls, so an earlier tool turn passes Anthropic with thinking on ([conversations](../packages/ai/llms/chat-conversations.md)).
- `kay check` warns when `i18n.paths` translates the default locale, whose path is the pattern: a link written as the translation would not localize ([locales](locales.md)).
- The sitemap lists a routed entry's translation at its own slug, and points each copy's `xhtml:link` alternates at the others' own slugs, as the page's `<link rel="alternate">` does ([locales](locales.md)).
- A second `else`, or an `else` after a line that separates it from its `if` or `for`, gets a message of its own that points at the first `else` or the line between, instead of "must directly follow an `if`".
- A `for` loop's index nothing reads is reported by `unread-name` like any other unused name, without `noUnusedParameters`; start it with `_` to keep it ([checks](checks.md#what-kay-check-verifies)).
- A tool action whose options are a variable, or whose `tool` is spread from another object, lists its derived `outputSchema` like one written inline ([actions](action-protection.md)).
- `kay fmt --from-html` writes the text of `pre`, `textarea` and `listing` as one `|` line per source line, keeping its line breaks and spaces, instead of collapsing it and noting it ([migrating from HTML](https://kayjs.kaynooo.fr/migrating/from-html)).
- A second `props()` call is the one reported, with the first as the span it repeats, instead of the first being called misplaced.

## 1.93.0

- A `local()` collection signed out stays so until the visitor is back: `retry()` and a retry armed while the server was unreachable no longer send the queue again, nor turn the status to `offline` ([local collections](local-collections.md)).
- kayjs-ui drops the prop names 1.89 deprecated: `isDisabled` on the date inputs and Widget's `isEmpty` and `@empty` are gone with their `deprecated-ui-props` lint ([upgrading](upgrading.md)).
- kayjs-ui's `TooltipHost` shows a `data-hint`, or the `data-tooltip` of an element no tap acts on, when a touch screen taps it, and hides it on a second tap or a tap elsewhere: hints on a phone are readable with nothing to add ([tooltips](../packages/ui/llms/basics.md)).
- kay/test's `page.tap(selector)` taps an element as a finger does, with `touch` pointer events, so a touch-screen behaviour is tested without raw DevTools touch events ([browser tests](testing-browser.md)).

Releases before 1.93 are in the notes of their releases, at https://git.kaynooo.fr/kaynooo/kayjs/releases.
