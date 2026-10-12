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
| `every` | A timer running while an island lives, and while a condition holds |
| `listen` | An event listener on `window`, `document` or another target while an island lives |
| `persisted`, `queryParam`, `linked`, `selection`, `context` | Signal helpers: stored, one query param of the page read by its schema, derived from a source, one selected key, shared down a tree |
| `s` | The schema builder for actions, config and content (`s.Object`, `s.String`, ...) |
| `action` | A form post or island call checked by a schema. See [Forms and actions](/essentials/forms-and-actions) |
| `guard` | A route guard. See [Sessions and guards](/guides/sessions-and-guards) |
| `defer` | Makes a promise an `await` block can stream |
| `navigate`, `refresh` | Go to a page, or re-render the current one, without a reload |
| `guardLeave` | Warns before leaving a page with unsaved changes |
| `resource`, `call`, `socket`, `stream`, `dispatch` | Typed reads and calls of API routes, websockets and event streams from islands; `call` throws `ApiError`. See [API routes](/guides/api-routes) |
| `publicEnv` | The variables `publicEnv` in the config exposed to islands |
| `localPath`, `withBase` | A path with the locale prefix or the `base` applied |
| `sanitizeHtml`, `trustHtml` | Clean untrusted HTML, its options typed `SanitizeOptions`, or mark HTML as safe to render |
| `uid` | A unique id that matches between server and browser |
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
| `rateLimit`, `memoryRates`, `sqliteRates`, `clientAddress` | Rate limiting |
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

## Other entry points

| Entry | Exports |
| --- | --- |
| `kay/content` | `collection`, `paginate`, `renderMarkdown`, `highlightCode`; for a CMS, `collections`, `entries`, `entrySource`, `entryFile`, `saveEntry`, `removeEntry`, `repositoryRoot`, `reference`, `imageField`, `fileField`, `markdownField`. See [Content](/guides/content) |
| `kay/edit` | `showDraft`, which shows the page with an editor's unsaved entries in edit mode, and the `EditorProps` an extension's `editor` is given. See [Content](/guides/content) |
| `kay/markdown` | `markdownHtml`, sanitized Markdown on the server and in an island. See [Content](/guides/content#markdown-in-an-island) |
| `kay/seo` | `siteUrl`, `siteOrigin`, `jsonLd`, `breadcrumbList`. See [Head and SEO](/essentials/head-and-seo) |
| `kay/i18n` | `t`, `locale`, `localize`, `alternate`, `formatNumber`, `formatDate`, `formatRelativeTime`, `relativeTime`, `formatList`, `direction`, `defineMessages`. See [Internationalization](/guides/i18n) |
| `kay/params` | The route matchers `integer`, `uuid` and `slug` |
| `kay/cache` | `cached`, `invalidate`, `sqliteCache`. See [Caching and streaming](/guides/caching-and-streaming) |
| `kay/image` | `image`, `shareImage`, `shareCard` |
| `kay/icons` | `iconProps`, `iconNames`, for icons known only at runtime |
| `kay/test` | `testSite`, `mount`, `browse`. See [Testing](/guides/testing) |
| `kay/bun` | `kay`, the Bun plugin compiling `.kay` files for a page kay does not serve. See [Islands](/essentials/islands#a-page-kay-does-not-serve) |
| `kay/mount` | `mount`, which renders a component into an element on a page kay does not serve. See [Islands](/essentials/islands#a-page-kay-does-not-serve) |
| `kay/eslint` | The ESLint processor for `.kay` files. See [Checks](/reference/checks) |
| `kay/tsconfig.json` | The base tsconfig a project extends |

<Callout type="note">

`kay/i18n` has its own `t` for messages, which `.kay` files read with no import; the schema builder is `kay`'s `s`, its old name `t` deprecated.

</Callout>

<ReadMore href="/llms">Every export and its signature are in the full reference, topic by topic.</ReadMore>
