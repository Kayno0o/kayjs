# What's new

What each release of kay and its libraries adds, newest first, each feature with where it is documented. kay and its libraries share one version, so one section covers them all; what a release breaks is in [Upgrading](upgrading.md).

## Unreleased

- `site.submit(action, fields, { from: '/path' })` solves a `workChallenge` field of the form on that page, as `from: await site.visit(...)` does: [Testing](testing.md).
- The placeholder `kay build --compile --verify-load` gives a string field reads as the field's first `enum` value, or a sample its `format` or `pattern` accepts, so a module validating it at load, as `new URL(env.X)` does, loads: [Production](production.md#check-the-executable-starts).
- The placeholder `kay build --compile --verify-load` gives a string field reads as the field's first `enum` value, or one of kay's samples its `format` or `pattern` accepts (a URL, an email, a pattern's literal start), so a module validating it at load, as `new URL(env.X)` does, loads: [Production](production.md#check-the-executable-starts).
- A test run needs no `KAY_SECRET` and no writable `.kay` for its secret: under `bun test` the derived secret takes a seed of the process when `.kay/dev-secret` is missing, and `testSite()` with an unwritable `.kay` fails with one message naming the folder and `islands: false`: [Environment](environment.md).
- kayjs-auth's background prune of expired, erased and guest data is waited for by `site.runJobs()`, so a test of retention settings needs no sleep.
- `signed.sign(use, value, { maxAge })` and `signed.verify(use, value, token)` from `kay/server` sign an app's own links and values with the app secret, expiring, so an app needs no key file of its own: [The app secret](environment.md#the-app-secret).
- kayjs-ai `Chat` sends the text of a `kai-chat-send` event on its `.kai-chat` as the next message, so a voice button beside it can post a transcript without touching its field: [Chat](../packages/ai/llms/chat.md).
- A browser test moves a page's clock with `page.advance('30s')`, running the `every()` and timer ticks due in that span, so a polling island is tested without waiting: [Browser tests](testing-browser.md).
- A test run needs no `KAY_SECRET` and no writable `.kay` for its secret: under `bun test` the derived secret takes a seed of the process when `.kay/dev-secret` is missing (shared with subprocesses through `KAY_DEV_SEED`), and `testSite()` with an unwritable `.kay` fails with one message naming the folder and `islands: false`: [Environment](environment.md).
- kayjs-cms's `cmsTest(site)` adds `delete`, `rename`, `move` and `upload`, and `save`, `delete` and `rename` read the entry's `version` themselves when none is named, so a test no longer hand-rolls the calls as the contract moves: [kayjs-cms options](../packages/cms/llms/options.md).
- `unbounded-string` stays quiet on a string field whose `enum`, `const` or anchored `pattern` with no `*`, `+` or `{n,}` already bounds its length: [Checks](checks.md).
- An island passes a `Blob` to an `s.File()` or `s.Files()` field, a `MediaRecorder` recording as it is, and `kay check` accepts it where it asked for a `File`; the handler still gets a `File`: [Files](files.md#files-posted-to-an-action).
- `session()` no longer warns in production that a cookie with no store cannot be revoked when kayjs-auth uses it, which keeps its own record of each session and refuses a cookie whose session it ended: [Sessions](server.md).
- `kay check` reports an `s.Public` field in a `.ts` file outside `src` (`public-env-outside-src`), where kay does not find it and an island reads it as a string: [Environment](environment.md).
- `kay upgrade` runs `bun update bun` itself when the install leaves an npm `bun` (the peer of `bun-plugin-tailwind`) older than the Bun kay needs, so kay runs right after it: [kay upgrade](check-and-tools.md).
- `kay upgrade` says `nothing left to do by hand` only when its last check printed nothing, warnings such as `promoted-island` included, and exits 1 otherwise: [kay upgrade](check-and-tools.md).
- `kay check --fix` checks what is left against `kay.config.ts` as the fixes left it, so a fix that rewrites the config no longer ends the same run on locals typed off the old one (`Property 'auth' does not exist on type 'object'`): [Check the project](check-and-tools.md#check-the-project).
- `kay check --fix` checks what is left against `kay.config.ts` as the fixes left it, so a fix that rewrites the config no longer ends the same run on locals typed off the old one (`Property 'auth' does not exist on type 'object'`): [Check and tools](check-and-tools.md).
- `security.permissions` grants one `Permissions-Policy` feature, `{ microphone: 'self' }`, merged over kay's list instead of replacing the whole header: [Security headers](proxy-and-security.md#security-headers).
- A session cookie minted by `auth.sessionCookie()` before the first `testSite()` signs the request in, where it read as anonymous once the site's `store` held the sessions: [kayjs-auth testing](../packages/auth/llms/hardening-and-testing.md).
- kayjs-ui's Button, framed IconButton and stat badge take their hairline and fill from the documented `--shell-line` and `--shell-fill` (the private `--_shell-line` and `--_shell-fill` are gone), set as utilities on the part in `src/ui.ts`: [Setup](../packages/ui/llms/setup.md).
- A `for` destructures its item, `for { id, name } of rows` or `for [key, count] of entries`, in the server render, in islands and in `kay check`, where it was a `Malformed for` error: [Templates](templates.md#render-a-list).
- kayjs-ui `Table` takes `sortParam`, keeping the sort a header click picks in the URL beside `filterParam`, so a reload and back and forward sort the same: [Tables](../packages/ui/llms/tables-navigation-and-layout.md).
- `kay check` reports a root Dockerfile building `FROM oven/bun:<version>` from a Bun older than the one kay needs (`old-bun-image`), and `kay check --fix`, so `kay upgrade`, moves the tag to the oldest Bun kay runs on, so an image build no longer fails after an upgrade: [Lints](lints.md).
- `kay check` and `kay upgrade` name an export `kay.config.ts` imports and a release removed (`mailExtension`, `authExtension`, `authPages`) with what replaced it, instead of stopping on Bun's bare `SyntaxError`: [upgrading](upgrading.md).
- `kay build --compile --verify-load` loads a module reading a `defineEnv` field at load, such as an app's `session({ secret })` or `createAuth({ secret })`, with no environment: the field reads as a placeholder there: [Production](production.md#check-the-executable-starts).
- `kay check` reports a kayjs-ui theme token or utility still written under its removed `kui-` name (`bg-kui-surface2`, `var(--color-kui-muted)`) as `removed-ui-token`, in `.kay` classes, `@apply`, stylesheets and src/ui.ts, and `kay check --fix` rewrites it where a new name stands for it; the `--kui-border-*` knobs are reported for a hand fix instead of being mapped to `--border-width`: [Upgrading](upgrading.md), [checks](lints.md).
- An `ActionError`'s `message` reads what a visitor can show: the string given to `ctx.fail`, the form-wide message, the schema's field messages, or the handler data's `message`, rather than the serialized body: [Actions from islands](actions-from-islands.md).
- An `ActionError`'s `message` reads what a visitor can show: the string given to `ctx.fail`, the form-wide message, the schema's field messages, or the handler data's `message`, rather than the serialized body it carried before (`Action failed with 502: [...]`), which only a refusal that says nothing readable still gives: [Actions from islands](actions-from-islands.md).
- The raw environment read check and `kay check --fix` leave a standalone binary's entry (a file a `bun build` script names, wherever it sits) with what it imports, the content config and a file with a `// kay-env: raw` line alone, so they no longer import the app's schema: [Environment](environment.md).
- A test run (`NODE_ENV=test`, as `bun test` sets) no longer warns that `proxy.key` is set with no `KAY_PROXY_KEY`, so an app behind a proxy has no warning in every test file; `kay start` outside production still does: [proxy and security](proxy-and-security.md).
- `kay upgrade` across a release that dropped deprecated lints installs the minor before that release first, so an app moving from 1.70 to the latest still gets the 1.71 and 1.72 forms rewritten instead of keeping them silently: [kay upgrade](check-and-tools.md).
- `kay check` warns (`missing-captcha`) on a call to kayjs-auth's `register`, `requestPasswordReset`, `requestMagicLink` or `signInWithPassword` with no `captcha` option, which the default proof of work refuses (quiet project-wide, in the editor too, once a `createAuth` sets `captcha: false`): [Bots and breached passwords](../packages/auth/llms/hardening-and-testing.md).

## 1.77.2

- kayjs-ai `ask(..., { reasoning })` takes `'none'`, `'low'`, `'medium'` or `'high'` and sends it as `reasoning_effort` to an OpenAI-compatible server, so a reasoning model such as Ollama's answers a short question in about a second: [asking](../packages/ai/llms/asking.md#ask-options).
- A direct child of `<body>` a script marks `data-kay-keep` lives on through every page swap, and kayjs-ui's `announce()` marks its live region, so words said just before a swap, such as kayjs-cms's `Title updated` on ending an inline edit, are still read: [Navigation](navigation.md).
- The `server` Dockerfile `kay new` writes runs on `debian:trixie-slim` (Debian 13) instead of bookworm, which only gets security fixes: [kay new](project-new-and-add.md).
- kayjs-mail requires nodemailer 10.2.1 and up, past three addressparser advisories (GHSA-85x2-q946-cp5h, GHSA-8c8m-p3m8-cjg8, GHSA-m943-m63m-w62w): [kayjs-mail](../packages/mail/llms.txt).

## 1.77.1

- A `kay build --compile` executable carries the modules declaring `s.Public`, so `publicEnv` and `/_kay/env.js` work where no `src` sits beside it, as in a container image holding the executable alone: [Environment](environment.md).

## 1.77.0

- kayjs-auth's tables rename the pre-1.71 `auth_*` ones again, for good, so a database still on them moves straight to this version with its users: [Upgrading](upgrading.md).
- kayjs-ui `stepDraft`'s `maxAge` takes a duration only, and `deprecated-step-draft-max-age` is gone: [Upgrading](upgrading.md).

## 1.76.0

- A Segmented or RadioGroup option can carry `value: null` for a "none" choice when `value` is typed nullable, checked while the group holds `null` and heard by `onChange` as `null`, and `kay check` fails one on a non-nullable `value` or beside an option of `""`, for literal or union option types ([Segmented](../packages/ui/llms/tables-navigation-and-layout.md)).
- `kay build --static` no longer touches the config `store`, so a `pgData` database gets no polling, connection or tables from it ([Static export](prerendering.md#static-export)).
- `kay start --workers <n|auto>`, and `./server --workers <n|auto>` for the executable, serve from several Bun processes on one port with the stores they need shared by kay itself: [Several workers](workers.md).
- `workflow()` writes a multi-step flow that survives restarts, sleeps for days and waits for events, with `step.run`, `step.sleep`, `step.waitFor`, one-call `start` and `send`, on the existing job stores ([Queues](queues.md)).
- The Jobs tab and the jobs page show a `workflow()` run by its state and steps, and send the event it waits for or cancel it ([Queues](queues.md)).
- `src/routes/_card.kay` lays out the share card `shareCard()` links with the app's own components, Tailwind classes and fonts, drawn by Chrome at build and on demand, and the fixed layout stays the default without it: [Lay out a share card yourself](images.md#lay-out-a-share-card-yourself).
- kayjs-mail stops mailing an address that bounced or complained, learned from a Postmark, Mailgun, SendGrid, Resend or Amazon SES (through SNS) webhook or a delivery report, drops it from the mailing lists (a complaint stops bulk mail only, not a password reset), reads a reply's attachment names as bare decoded file names, and `mailer({ inbound })` takes a reply as a function call ([Bounces, complaints and replies](../packages/mail/llms/bounces-and-replies.md)).
- `push()` adds web push: `sendPush(userId, ...)` on the server, `webPush.subscribe()` in an island, `installPrompt` (which needs no `push()`: a page with an island using it keeps the browser's install offer from the first moment), and `notify()` also pushes to a person who opted in, and the worker subscribes a rotated subscription again by itself ([Notifications](notifications.md#push-to-a-persons-devices)).
- The docs have a [playground](https://kayjs.kaynooo.fr/getting-started/playground): kay's compiler runs in the browser, so a component is edited and run there with no install, and each docs example it can run (a component importing from `kay` alone) links to it from its header.
- `local({ key, read, put, remove })` keeps a collection in IndexedDB, so an island reads and writes it at once, offline too, and the writes are replayed through the collection's actions, once each (an `x-kay-write` id any action honours), by background sync where the browser has it ([Local collections](local-collections.md)).
- kayjs-auth: `auth.userIdsHolding(role)` lists the ids of the users holding a role or one above it, for server code that notifies them ([Admin and organizations](../packages/auth/llms/admin-and-organizations.md)).
- A cms writer without `publish` sends a draft for review, and a reviewer holding the new `review` action approves it (publishing or scheduling it) or sends it back with a note, each kept in the entry's history and told through `notify()`; `roles` keys can name kayjs-auth organization roles as `org:<role>` ([Review](../packages/cms/llms/review.md)).
- `live(0, { user: true })` is a value of each signed-in user, sent only to that user's own tabs, and a deferred server island reading a `cached(..., { live: true })` value or live collection is fetched again alone when it changes, with no request for the page ([Live values](live-values.md#a-value-that-is-one-users-own)).
- A page hook is given `fileSize(url)` and `htmlSize(html)`, the compressed sizes a browser downloads, read from the copies the compress stage keeps so that a hook measuring page weight compresses no file twice ([Page hooks](prerendering.md#page-hooks)).
- A server started with `kay start` renders a static component inside an island on a page that is not prerendered, `_404` and `_error` included, where it logged `KayHydrated is not a function` and answered 500 or lost the layout.
- `cms({ fourEyes: true })` keeps the person who sent a draft for review from approving it ([Review](../packages/cms/llms/review.md)).

## 1.75.0

- A rebuild no longer gets a new stylesheet when the app's CSS has `@source '../.kay/classes.txt'`: `.kay` holds a `.gitignore` of everything but the `kay/test` scratch projects, so Tailwind reads that one file and not the build's own output ([Styles and assets](styles-and-assets.md)).

## 1.74.0

- A `pgData` store has `close()` (and `await using`), ending its polling and timers and closing the pool it opened from a URL ([Queues](queues.md)).

## 1.73.0

- kayjs-ui: `stepDraft`'s `maxAge` is a duration (`'1h'`); a number of seconds works until 1.77 ([Forms and steps](../packages/ui/llms/forms-and-steps.md)).
- A link pressed while a view transition runs no longer reports an `AbortError` to `/_kay/error` when the transition is skipped before its animations start.
- kayjs-ui: `Toolbar`, `PageSection` takes `subtitle` and `sticky`, and `SidePanel` takes `launcher` and `launcherLayer`; the cms editor's list bars, entry heads, collapsed button and Stop editing question are built on them ([Toolbar](../packages/ui/llms/page-layout-palette-and-trees.md)).
- kayjs-ui: `SidePanel` takes `dock` to sit beside the page as a resizable tool panel, and `Menu` and `Popover` take `at` to open at a point with no trigger, and every `Menu` scrolls past the window height and has taller entries on touch ([SidePanel](../packages/ui/llms/page-layout-palette-and-trees.md), [Menu](../packages/ui/llms/forms.md)).
- kayjs-cms: an image the page shows from an image field is replaced on the page, with a Replace button over it or a file dropped on it ([Editor](../packages/cms/llms/editor.md)).
- kayjs-cms: a long text and the paragraphs, headings and list items of Markdown are typed in place on the page, as their source, with the caret where the click landed ([Editor](../packages/cms/llms/editor.md)).
- kayjs-cms: the on-page editor reads an entry of a page with several (a menu, a footer) only once it is opened or clicked, and a click on a field puts the caret in its input where the click landed, the Markdown body included ([Editor](../packages/cms/llms/editor.md)).
- kayjs-cms: the on-page editor titles an entry by itself, collapses its form to the field clicked or typed on the page with anchors to the others, and offers Save all over several entries ([Editor](../packages/cms/llms/editor.md)).

Releases before 1.73 are in [What's new, older releases](whats-new-archive.md).
