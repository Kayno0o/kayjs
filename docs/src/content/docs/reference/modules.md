---
title: Modules
order: 3
description: What each public kay entry point exports.
---
Import from the entry point that matches where the code runs. `kay` works in pages, components and islands, and `kay/server` only on the server. A topic's own entry, such as `kay/i18n`, `kay/cache` or `kay/content`, holds that topic's helpers, whichever side runs them.

```ts
import { action, s, signal } from 'kay'
import { defineConfig, pages, session } from 'kay/server'
import { collection } from 'kay/content'
```

Inside a `.kay` file, `signal`, `memo`, `effect`, `onMount`, `onCleanup`, `props`, a server fence's `action` and the translation `t` need no import. A component is written with them. Everything else is imported, and components, such as `T`, are always imported.

## kay

| Export | Is |
| --- | --- |
| `signal`, `memo`, `effect`, `batch`, `untrack`, `onMount`, `onCleanup` | Reactivity |
| `root` | An owner of its own, so effects created inside live until its `dispose` is called. See [Islands](/essentials/islands#effects-outside-a-component) |
| `live` | A value the server changes and every page showing it follows. See [Live and realtime](/guides/live-and-realtime#values-the-server-changes) |
| `watch`, `debounced` | Code running on a change only, handed the value before, and a value once it stops changing |
| `every` | A timer running while an island lives, and while a condition holds |
| `listen` | An event listener on `window`, `document` or another target while an island lives |
| `persisted`, `queryParam`, `linked`, `selection`, `context` | Signal helpers: stored, one query param of the page read by its schema, derived from a source, one selected key, shared down a tree |
| `s` | The schema builder for actions, config and content (`s.Object`, `s.String`, ...) |
| `action` | A form post or island call checked by a schema. See [Forms and actions](/essentials/forms-and-actions) |
| `ActionError`, `ActionRedirect` | What an action called from an island throws: its schema's messages, or the redirect it answered |
| `focusInvalid`, `flush` | Focus the first invalid field once pending writes rendered; run pending effects now |
| `guard` | A route guard. See [Sessions and guards](/guides/sessions-and-guards) |
| `defer` | No longer needed, as an `await` block streams any promise; returns the promise as is |
| `navigate`, `refresh` | Go to a page, or re-render the current one, without a reload |
| `searchResults`, `searchSite` | The site search from an island: following a signal holding the query, or as a promise |
| `shortcut` | Binds a keyboard shortcut such as `mod+s` for as long as the island lives, on the page or one element. See [Islands](/essentials/islands#keyboard-shortcuts) |
| `guardLeave` | Warns before leaving a page with unsaved changes |
| `resource`, `call`, `socket`, `stream`, `dispatch` | Typed reads and calls of API routes, websockets and event streams from islands; `call` throws `ApiError`, which has the route's `status`, 0 when no answer came, and its `answer`. See [API routes](/guides/api-routes) |
| `publicEnv` | The variables `publicEnv` in the config exposed to islands |
| `localPath`, `withBase` | A path with the locale prefix or the `base` applied |
| `sanitizeHtml`, `trustHtml` | Clean untrusted HTML, its options typed `SanitizeOptions`, or mark HTML as safe to render, which a spread's `innerHTML` requires |
| `uid` | A unique id that matches between server and browser |
| `describeField` | Adds ids to the `aria-describedby` of the first field a component renders, for a form field linking its parent's hint |
| `markInvalid` | Marks a field `aria-invalid` for one of several sources, and clears the mark once none holds it |
| `previewing` | Whether the visitor is in preview mode |
| `editing` | Whether the visitor is in edit mode, a CMS editing content on the page |
| `logFrom` | A library's log, `logFrom('my-library').error(message, error)`, written where the app's `log` setting sends kay's messages, or to the console as `[my-library] message` outside a server |

Types include `Component`, `Signal`, `Guard`, `Duration`, `PageContext`, `EndpointContext`, `EndpointBody` and `Locals`.

## kay/server

| Export | Is |
| --- | --- |
| `pages` | The Elysia plugin serving the project's pages |
| `defineConfig` | Types `kay.config.ts` |
| `api`, `eventStream` | An API module under `src/api`, and server-sent events |
| `session`, `memoryStore`, `sqliteStore` | Cookie sessions and their stores. See [Sessions and guards](/guides/sessions-and-guards) |
| `defineEnv` | Reads `process.env` once against a schema, typed |
| `rateLimit`, `memoryRates`, `sqliteRates`, `clientAddress`, `rateKey` | Rate limiting, and the key a limit counts an address under |
| `crossSiteRefused`, `crossSiteResponse` | Whether a browser's cross-site POST or websocket upgrade should be refused, for code that kay's actions and API do not reach, and the 403 to answer it with. See [Security](/guides/security#a-post-from-another-site) |
| `toolCall` | Whether a request is a tool call that `/mcp` passed on, and which. See [API routes](/guides/api-routes#telling-a-tool-call-apart) |
| `workChallenge`, `verifyWork` | Proof of work in a form field your own code checks |
| `requestId` | The id of a request, on its log lines and its `X-Request-Id` header |
| `schedule`, `background` | Jobs on a cron or every so long, and background work, in the server's process |
| `queue`, `memoryJobs`, `sqliteJobs` | Durable jobs with retries |
| `rooms`, `memoryRooms`, `sqliteRooms` | Websocket rooms |
| `enterPreview`, `exitPreview`, `previewUrl` | Preview mode for drafts, edit mode with `{ edit: true }` |
| `editRequested` | Whether a request is in edit mode |
| `renderToString` | Renders a component to a string, for mails and feeds |
| `renderLocale` | The locale `renderToString` renders in: the one given, the request's, else the site's default |
| `processImage`, `imageSize` | Resize or measure an image |
| `files`, `diskFiles`, `s3Files`, `memoryFiles` | Stored uploads and their stores. See [File storage](/guides/file-storage) |
| `shutdown` | Stops the server gracefully |
| `inlineScriptHashes` | The CSP hashes of kay's inline scripts, for a policy written elsewhere |

Types include `BrowserError` and `CspViolation`, the browser errors and CSP violations `onError` receives.

## Other entry points

| Entry | Exports |
| --- | --- |
| `kay/content` | `collection`, `paginate`, `renderMarkdown`, `highlightCode`; for a CMS, `bodyHtml`, `MarkdownError`, `collections`, `collectionInfo`, `entries`, `entrySource`, `entryFile`, `saveEntry`, `removeEntry`, `repositoryRoot`, `reference`, `imageField`, `fileField`, `markdownField`. See [Content](/guides/content) |
| `kay/edit` | `showDraft`, which shows the page with an editor's unsaved entries in edit mode, and the `EditorProps` an extension's `editor` is given. See [Content](/guides/content) |
| `kay/dev-tool` | The `DevTool` type a library's `devTool` module is given, with `make`, `tab`, `button`, `outline`, `hideOutline` and `open`, and the `DevTab` and `DevTabOptions` of `tab`. See [A tab for a library](/llms/component-libraries#a-tab-for-a-library) |
| `kay/compiler` | `compileKay`, which compiles one `.kay` source, `formatDiagnostic`, which prints a problem it found, and the `Diagnostic`, `CompileOptions` and `CompileResult` types. See [Compiling a component](/llms/check-and-tools#compile-a-component-from-a-tool) |
| `kay/markdown` | `markdownHtml`, sanitized Markdown on the server and in an island. See [Content](/guides/content#markdown-in-an-island) |
| `kay/seo` | `siteUrl`, `siteOrigin`, `jsonLd`, `breadcrumbList`. See [Head and SEO](/essentials/head-and-seo) |
| `kay/i18n` | `t`, `locale`, `locales`, `localeName`, `localize`, `alternate`, `formatNumber`, `formatDate`, `formatRelativeTime`, `relativeTime`, `formatList`, `direction`, `defineMessages`. See [Internationalization](/guides/i18n) |
| `kay/words` | `wording`, `pageLocale`: the lookup a library words its default texts through. See [Internationalization](/guides/i18n) |
| `kay/params` | The route matchers `integer`, `uuid` and `slug` |
| `kay/cache` | `cached`, `invalidate`, `invalidatePage`, `sqliteCache`. See [Caching and streaming](/guides/caching-and-streaming) |
| `kay/image` | `image`, `shareImage`, `shareCard` |
| `kay/icons` | `iconProps`, `iconNames`, for icons known only at runtime |
| `kay/test` | `testSite`, `mount`, `browse`, `browserPath`, `settle`, `readPersisted`, `writePersisted`, `cookieJar`, `solveWork`, `scratchDir`. See [Testing](/guides/testing) |
| `kay/test/preload` | The preload a project's `bunfig.toml` lists for `bun test`, before any other registering a DOM |
| `kay/test/dom` | The preload registering happy-dom's DOM, popover API included, for `mount`. See [Testing](/guides/testing#one-component) |
| `kay/bun` | `kay`, the Bun plugin compiling `.kay` files for a page kay does not serve. See [Islands](/essentials/islands#a-page-kay-does-not-serve) |
| `kay/mount` | `mount`, which renders a component into an element on a page kay does not serve. See [Islands](/essentials/islands#a-page-kay-does-not-serve) |
| `kay/eslint` | The ESLint processor for `.kay` files. See [Checks](/reference/checks) |
| `kay/tsconfig.json` | The base tsconfig a project extends |

<Callout type="note">

`kay/i18n` has its own `t` for messages, which `.kay` files read with no import; the schema builder is `kay`'s `s`.

</Callout>

<ReadMore href="/llms">Every export and its signature are in the full reference, topic by topic.</ReadMore>
