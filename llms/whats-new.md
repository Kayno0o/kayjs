# What's new

What each release of kay and its libraries adds, newest first, each feature with where it is documented. kay and its libraries share one version, so one section covers them all; what a release breaks is in [Upgrading](upgrading.md).

## Unreleased

- A tool's input schema, and the OpenAPI document, describe `s.Integer()` and `s.Numeric()` as a number alone, and a tool's schema no longer requires a field with a `default` ([tools](api-routes.md)).
- A stale tab believes the build the server named for 5 seconds, and a page an action post came back to as an error page (a 404, a guard's denial) carries `kay-posted` too, so a reload no longer posts it again ([a deploy under open tabs](production.md#a-deploy-under-open-tabs)).
- `kay i18n translate` translates a long entry body in parts instead of failing on the reply cap ([translating](../packages/ai/llms/translating.md)).
- `untranslated(schema)` from `kay/content` keeps a field out of `kay i18n translate`, whose dry run now lists the field paths of each entry ([content CMS](content-cms.md), [translating](../packages/ai/llms/translating.md)).
- kayjs-ai: `kay i18n translate` translates the `title`, `alt`, `aria-label` and `placeholder` of a tag and still holds its other attributes ([translating](../packages/ai/llms/translating.md)).
- `kay doctor` tries the port on `HOST` or else `localhost`, passes `PORT=0` as the system's pick, and reads a manifest again once when it is being written ([kay doctor](check-and-tools.md)).
- A production build keeps the runtime split per island for a file that also imports `kay` as a namespace or default beside import text in a template literal or a comment, which it used to rewrite.
- kayjs-cms: in the on-page editor, the issues of a refused save stay shown when a draft render was pending, until the next edit ([kayjs-cms](../packages/cms/llms.txt)).
- An executable from `kay build --compile` maps an island's report and the stacks in its logs to `.kay` lines, with its maps embedded compressed, and a slow `onError` holds a queue worker for 10 seconds at most ([Build and start](build-and-start.md), [Error reporting](routing.md#error-reporting)).
- A warm build with `--compile` no longer compiles every `.kay` file again for its embedded maps, and the stacks of a static component rendered inside an island map to `.kay` lines in an executable ([Build and start](build-and-start.md)).
- An island passed an action without typing a prop with `Action` fails the render naming the fix, in production as in dev, instead of failing in the browser ([actions to islands](actions.md#pass-an-action-to-an-island)).
- A static component promoted to an island and passed an action works in the browser when it types a prop with `Action`, and fails the render naming the fix when it does not ([actions to islands](actions.md#pass-an-action-to-an-island)).
- `onError` gets the errors of `schedule`, `background` and queue jobs and `onStop` hooks, with no request, and an island's stack is mapped to `.kay` lines in production ([Error reporting](routing.md#error-reporting), [Error fallbacks](islands.md#error-fallbacks)).
- kayjs-cms: `cms({ collections })` arranges a form (field order, rows of columns, hidden fields) and a list (columns, row actions), and the screens' parts, `createEntryForm`, `entryScreen` and `listScreen` are exported to build an entry screen of your own ([screens](../packages/cms/llms/screens.md)).
- A page of many rules, Markdown pages included, links a copy of the stylesheet cut to the classes it names instead of every component's rules, loaded before a page swap paints ([styles](styles-and-assets.md#link-or-inline-the-stylesheets)).
- kayjs-ai's `Chat` announces each tool call's start and end to screen readers through its polite status line, and a Stop before the first word returns the message to the field ([Chat island](../packages/ai/llms/chat.md)).
- kayjs-ai's `Chat` names each table of a reply as a `group`, numbered when a reply has several, and escapes `tableLabel` ([Chat island](../packages/ai/llms/chat.md)).
- A tab opened before a deploy reloads itself, the scroll kept and what was typed left alone, on the next island it fails to load; production answers carry `x-kay-build` ([a deploy under open tabs](production.md#a-deploy-under-open-tabs)).
- kayjs-cms: a list of `imageField()` or `fileField()` takes several files dropped or picked at once, one item per file ([kayjs-cms](../packages/cms/llms.txt)).
- `unreachable-tooltip` no longer takes an `aria-label` on a role-less `span` or `div` as a fix, and leaves an expression `tabindex` or an element whose only text is its tooltip alone ([checks](checks.md)); kayjs-ui's TooltipHost describes the element it shows for with `aria-describedby`.
- `kay doctor` and an MCP `doctor` tool check Bun, kay and library versions, the config, the environment, the port and `.kay` in one report, with a fix beside each failure ([tools](check-and-tools.md)).
- The dev tool's Not found tab lists the paths production found nothing at, and turns one into a redirect with a click ([dev server](dev-server.md)).
- kayjs-cms lists those paths at `<prefix>/not-found`, with where visitors came from and a redirect line to copy ([Redirects](routing.md#redirects)).
- The dev tool's filters update a group's count, Head's hreflang alternates have a copy button, and a copy's outcome is announced to a screen reader ([dev server](dev-server.md)).
- `cached(key, ttl, load, { live: true })` has every open page that read the key show it afresh when `invalidate` drops it, with no socket or polling ([live data](api-from-islands.md#following-cached-values)).
- `kay build` keeps the chunks of the last 3 builds beside the new one, so a tab opened before a deploy still finds them ([a deploy under open tabs](production.md#a-deploy-under-open-tabs)).
- An island's markup names its chunk (`data-chunk`), so a page no longer loads a loader for every island of the app: the docs' 128 islands weigh 2 KB gzip less on every page ([Build and start](build-and-start.md)). Island markup now carries `data-chunk`, so a test matching a `<slot>` exactly changes, and markup from `renderToString` has none and hydrates nothing.
- A page no longer loads a runtime module only other pages' islands use: the action runtime or the image variants stay with the islands importing them, and the docs' entry drops from 21.0 to 15.4 KB gzip ([Build and start](build-and-start.md)).

## 1.52.3

- Claude Code lists an app's MCP tools: a list or a read in the 2026-07-28 revision says how long a client keeps it, `ttlMs` and `cacheScope`, as that revision requires ([API routes](api-routes.md#mcp)).
- A `resource()` reading a route whose handler reads a `live` cached key asks the route again after `invalidate`, with nothing written ([live data](api-from-islands.md#following-cached-values)).
- A collection with `live: true` shows an `invalidate()` or a CMS edit in every open page that read it ([content](content.md#drafts)).

## 1.52.2

- A page with a `--- server` fence passes an island an action, `Chat(action={reply})` with no wrapper ([actions](actions.md#pass-an-action-to-an-island)).
- `island-action` reports an action handed to an island that never types a prop as one ([actions](actions.md#pass-an-action-to-an-island)).
- `secret-prop` warns of a secret-looking field, as `user.passwordHash`, handed to an island ([islands](islands.md#props-to-an-island)).
- `kay screenshot` and an MCP `screenshot` tool shoot a page of `kay dev`, with a diff, and `--cookie` shoots one behind a session ([tools](check-and-tools.md#screenshot-a-page)).
- `kay not-found` lists the paths production found nothing at, with a target, and writes the redirect ([Redirects](routing.md#redirects)).
- `deprecated-api-tool` is reported by `kay upgrade` of an app from before 1.51 alone: an app turning `mcp` on since gets no warning for routes that do not opt in ([Checks](checks.md)).
- A stream an action answers with to a leaving row's handler or a `listen` callback closes with its island too ([actions from islands](api-from-islands.md)).
- A streamed `await` part's island cleans up still in the page ([Streaming](rendering.md#streaming)).

## 1.52.1

- `collection(..., { order: 'position' })` orders a collection by a number field, and kayjs-cms moves its entries up or down by writing it ([Content](content.md)).
- `collection(..., { title })` names a collection on the kayjs-cms screens ([Content](content.md)).
- kayjs-cms: every image preview has the same square box, and a list item carries no required asterisk. kayjs-ui: a grouped `FormField`'s legend keeps its layout under an app's own `legend` styles ([kayjs-cms](../packages/cms/llms.txt)).
- kayjs-cms: an image or file field keeps its path behind a collapsed Path control, the preview and the upload button alone showing ([kayjs-cms](../packages/cms/llms.txt)).
- kayjs-cms: the items of a list field move up and down, with buttons or Alt and an arrow key ([kayjs-cms](../packages/cms/llms.txt)).
- kayjs-cms: `s.Integer()`, `s.Numeric()`, `s.BooleanString()` and `s.Date()` fields get a number, toggle or date input, not a JSON box ([kayjs-cms](../packages/cms/llms.txt)).
- kayjs-cms: a literal's `title` labels its option in a select, the value staying what is stored ([kayjs-cms](../packages/cms/llms.txt)).
- kayjs-ai `Chat`: a wide table scrolls inside its bubble, a message refused with 422 returns to the field on a retry too, the history posted never opens on an assistant message, and an action that can `ctx.fail` is accepted as `action` ([kayjs-ai](../packages/ai/llms/chat.md)).
- A stream an action answers with to an event handler closes with its island, so a `persist` island's stays open across pages ([actions from islands](api-from-islands.md)).

Releases before 1.52.1 are in [What's new, older releases](whats-new-archive.md).
