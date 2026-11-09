# What's new

What each release of kay and its libraries adds, newest first, each feature with where it is documented. kay and its libraries share one version, so one section covers them all; what a release breaks is in [Upgrading](upgrading.md).

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

Releases before 1.93 are in [What's new, older releases](whats-new-archive.md).
