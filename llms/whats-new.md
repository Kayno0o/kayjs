# What's new

What each release of kay and its libraries adds, newest first, each feature with where it is documented. kay and its libraries share one version, so one section covers them all; what a release breaks is in [Upgrading](upgrading.md).

## Unreleased

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
