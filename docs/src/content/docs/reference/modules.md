---
title: Modules
order: 3
description: What each public kay entry point exports.
---
Import from the entry point that matches where the code runs. `kay` works in pages, components and islands, `kay/server` only on the server.

```ts
import { action, s, signal } from 'kay'
import { defineConfig, pages, session } from 'kay/server'
import { collection } from 'kay/content'
```

`signal`, `memo`, `effect`, `onMount`, `onCleanup`, `props`, a server fence's `action` and the translation `t` from `kay/i18n` need no import inside a `.kay` file.

## kay

| Export | Is |
| --- | --- |
| `signal`, `memo`, `effect`, `batch`, `untrack`, `onMount`, `onCleanup` | Reactivity |
| `watch`, `debounced` | Code running on a change only, handed the value before, and a value once it stops changing |
| `every` | A timer running while an island lives, and while a condition holds |
| `listen` | An event listener on `window`, `document` or another target while an island lives |
| `persisted`, `queryParam`, `linked`, `selection`, `context` | Signal helpers: stored, one query param of the page read by its schema, derived from a source, one selected key, shared down a tree |
| `s` | The schema builder for actions, config and content (`s.Object`, `s.String`, ...) |
| `action` | A form post or island call checked by a schema. See [Forms and actions](/essentials/forms-and-actions) |
| `ActionError`, `ActionRedirect` | What an action called from an island throws: its schema's messages, or the redirect it answered |
| `focusInvalid`, `flush` | Focus the first invalid field once pending writes rendered; run pending effects now |
| `guard` | A route guard. See [Sessions and guards](/guides/sessions-and-guards) |
| `defer` | Makes a promise an `await` block can stream |
| `navigate`, `refresh` | Go to a page, or re-render the current one, without a reload |
| `searchResults`, `searchSite` | The site search from an island: following a signal holding the query, or as a promise |
| `shortcut` | Binds a keyboard shortcut such as `mod+s` for as long as the island lives, on the page or one element. See [Islands](/essentials/islands#keyboard-shortcuts) |
| `guardLeave` | Warns before leaving a page with unsaved changes |
| `resource`, `call`, `socket`, `stream`, `dispatch` | Typed reads and calls of API routes, websockets and event streams from islands; `call` throws `ApiError`. See [API routes](/guides/api-routes) |
| `publicEnv` | The variables `publicEnv` in the config exposed to islands |
| `localPath`, `withBase` | A path with the locale prefix or the `base` applied |
| `sanitizeHtml`, `trustHtml` | Clean untrusted HTML, its options typed `SanitizeOptions`, or mark HTML as safe to render, which a spread's `innerHTML` requires |
| `uid` | A unique id that matches between server and browser |
| `describeField` | Adds ids to the `aria-describedby` of the first field a component renders on the server, its slot included, for a form field linking the control its parent writes to its hint |
| `markInvalid` | Marks a field `aria-invalid` for one source among several, such as a form field's own message beside a refused post in an island, taking the mark off once none holds it |
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
| `crossSiteRefused` | Whether a browser's cross-site POST or websocket upgrade should be refused, for code that kay's actions and API do not reach |
| `workChallenge`, `verifyWork` | Proof of work in a form field your own code checks |
| `requestId` | The id of a request, on its log lines and its `X-Request-Id` header |
| `schedule`, `background` | Jobs on a cron or every so long, and background work, in the server's process |
| `queue`, `memoryJobs`, `sqliteJobs` | Durable jobs with retries |
| `rooms`, `memoryRooms`, `sqliteRooms` | Websocket rooms |
| `invalidatePage` | Rebuilds a prerendered page |
| `enterPreview`, `exitPreview`, `previewUrl` | Preview mode for drafts, edit mode with `{ edit: true }` |
| `editRequested` | Whether a request is in edit mode |
| `renderToString` | Renders a component to a string, for mails and feeds |
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
| `kay/markdown` | `markdownHtml`, sanitized Markdown on the server and in an island. See [Content](/guides/content#markdown-in-an-island) |
| `kay/seo` | `siteUrl`, `siteOrigin`, `jsonLd`, `breadcrumbList`. See [Head and SEO](/essentials/head-and-seo) |
| `kay/i18n` | `t`, `locale`, `localize`, `alternate`, `formatNumber`, `formatDate`, `formatRelativeTime`, `relativeTime`, `formatList`, `direction`, `defineMessages`. See [Internationalization](/guides/i18n) |
| `kay/params` | The route matchers `integer`, `uuid` and `slug` |
| `kay/cache` | `cached`, `invalidate`, `sqliteCache`. See [Caching and streaming](/guides/caching-and-streaming) |
| `kay/image` | `image`, `shareImage`, `shareCard` |
| `kay/icons` | `iconProps`, `iconNames`, for icons known only at runtime |
| `kay/test` | `testSite`, `mount`, `browse`, `browserPath`, `settle`, `readPersisted`, `writePersisted`. See [Testing](/guides/testing) |
| `kay/test/preload` | The preload a project's `bunfig.toml` lists for `bun test`, before any other registering a DOM |
| `kay/bun` | `kay`, the Bun plugin compiling `.kay` files for a page kay does not serve. See [Islands](/essentials/islands#a-page-kay-does-not-serve) |
| `kay/mount` | `mount`, which renders a component into an element on a page kay does not serve. See [Islands](/essentials/islands#a-page-kay-does-not-serve) |
| `kay/eslint` | The ESLint processor for `.kay` files. See [Checks](/reference/checks) |
| `kay/tsconfig.json` | The base tsconfig a project extends |

<Callout type="note">

`kay/i18n` has its own `t` for messages, which `.kay` files read with no import; the schema builder is `kay`'s `s`, its old name `t` deprecated.

</Callout>

<ReadMore href="/llms">Every export and its signature are in the full reference, topic by topic.</ReadMore>
