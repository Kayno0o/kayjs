# What's new

What each release of kay and its libraries adds, newest first, each feature with where it is documented. kay and its libraries share one version, so one section covers them all; what a release breaks is in [Upgrading](upgrading.md).

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

## 1.72.0

- kayjs-mail: a list store that was closed leaves the sweep, so a later app of the process logs no "could not be swept" warning for it.
- A cms rename whose old address the full redirect set refuses toasts the editor why it will not redirect ([Rename](../packages/cms/llms/rename.md)).
- kayjs-cms: a signed-in editor is told editor names in the on-page editor after a restart, on another replica and in streamed blocks, and two edit-link holders never share an edit cookie, which an older replica of a rolling deploy does not read ([Editor](../packages/cms/llms/editor.md)).
- An element with a `part` and an attribute spread that brings no `class` renders no empty `class=""` on the server.
- An element with an attribute spread renders no empty `class=""` or `style=""` on the server, as in the browser.
- kayjs-ui marks every styleable element with `data-part` and keeps a state in its ARIA attribute or a named `data-*`; Steps sets `data-step` ([Restyle a component](../packages/ui/llms/setup.md#restyle-a-component)).
- `pgData` records the app owning its database in `kay_meta` and refuses to boot another app on it, `KAY_ADOPT_DATABASE=<old name>` handing it to a renamed app ([Queues](queues.md)).
- kayjs-ui has an `AppSwitcher`, a grid of dots opening tiles that link sibling apps ([Navigation](../packages/ui/llms/tables-navigation-and-layout.md)).
- A `store.rates` that hangs no longer holds kay's own routes (errors, live, analytics, vitals, MCP) past 8 seconds: they count in memory, logged once ([Queues](queues.md)).
- kayjs-mail: a queued mail and a list broadcast are sent, redacted and given up to `onFailed` by the mailer that queued it, mailers sharing a queue must agree on its retry and keep options, and a transport's `send` gets the queue's abort signal ([Other transports](../packages/mail/llms/contact-form-and-testing.md)).
- `sessions.deleteWhere({ userId })` takes an object of fields held equal, which the SQLite and Postgres stores narrow in the database instead of reading every session; a function match is read 500 at a time on SQLite too ([Server](server.md)).
- `sessions.deleteWhere({ userId })` filters in SQL ([Server](server.md)).
- `live(initial, { ttl: '7d' })` forgets a value that long after its last write in the memory, SQLite and Postgres stores alike, and `kay_live` gains an `expires_at` column ([Live values](live-values.md)).
- `live(0, { ttl: '7d' })` makes every store forget a value ([Live values](live-values.md)).
- `SubscribeForm` links the `privacy` page its `mail.list(name, { privacy })` declares, so an app names it once; kayjs-mail's list sweep timers end when `kay dev` reloads.
- kayjs-cms keeps its on-page drafts per signed-in person and forgets them at Sign out, closes the activity log to a role that may not `delete` (see Upgrading), and asks for a click before a link from another site opens edit mode ([Editor](../packages/cms/llms/editor.md)).
- A queue job whose store fails to mark it finished is no longer retried or kept as failed for it, and kay's own report routes and a proof of work's used solutions now count in the app store's `rates`, shared by replicas ([Queues](queues.md), [Proof of work](action-protection.md)).
- A rooms, cache or publication-date listener that throws is logged and the listeners after it still run, and every method of the Postgres stores is time limited.
- Stored values stale for a week are dropped by the next write, a throwing cache or rooms listener no longer stops the poll, a refused request (403, 429, 422) no longer makes a kept page render again, and a rooms file that cannot be watched backs off its 25 ms read ([Caching](rendering.md), [Rooms](rooms.md)).
- Server and island render alike in small cases: a tag in capitals, the first newline of a `pre`, `listing` and `textarea`, a `script` holding JSON (`<` as `\u003c`), concurrent calls of one action (the last started shows), a prefetch made while a post was out ([Templates](templates-elements-slots-snippets.md), [Security](proxy-and-security.md)).
- `kay check` and the language server stop waiting for a `kay.config.ts` that never settles after 30 seconds, and an effect loop stops after 1,000 rounds, naming the effect in development.
- kayjs-cms moves entries of a loaded collection by writing only their order field, refused if another process changed it since (`expect` of `saveMany`, `ContentChangedError`). Its hourly sweep reads revision indexes, and the trash and activity only once a row can have expired, erase answers 404 for an unknown collection and the media library labels uploads a revision or the trash holds ([Loaders](../packages/cms/llms/loaders.md), [Content](content-cms.md)).
- kayjs-cms names the other editors to a signed-in person in the on-page editor and sends an edit link's holder none, only a count, whichever editor component a page renders ([Screens](../packages/cms/llms/screens-replacing.md)).
- The Postgres and SQLite live and cache stores poll every 500 ms only while there is activity: an idle server with no tab watching a value backs off to 5 s, and a live store with no `live()` value declared, or a Postgres cache nothing used, is not polled ([Live values](live-values.md)).
- Postgres stores give up a call after 8 seconds with a logged error instead of hanging, and a room name is at most 256 characters, NUL allowed ([Jobs](queues.md), [Rooms](rooms.md)).
- A 413 for a body over the limit on a library's cross-origin route, such as kayjs-auth's `/auth/oauth/token`, carries the route's CORS grant, and a `maxSizes` entry at an `api()` module's path now wins over the module's `maxSize` keeping its grant ([Action protection](action-protection.md)).
- kayjs-ui roots write an app's `style` after their own declarations, so the app wins.
- The Styles tab and LSP show a part's classes written as an imported constant.
- kayjs-ui reads the app's own theme names (`--color-accent`, `--color-background`, `--radius-md`, `--density`), and the analytics consent banner now follows the app's `--color-accent`, `--color-surface`, `--color-foreground` and `--color-input` ([Setup](../packages/ui/llms/setup.md)).
- kayjs-ui's `eject` and `diff` refuse a path outside the library, `ContactForm` links its `privacy` page with `rel="noopener noreferrer"` like every outside link the library draws, `MarkdownEditor` escapes an uploaded image's URL in the markdown it inserts, and `Masonry` and `Sortable` drop what a removed tile left behind ([Forms](../packages/ui/llms/forms-and-steps.md)).
- A link kay opens in a new tab carries `data-new-tab`, and the page tells screen readers "(opens in a new tab)" under `kay.link.newTab` ([Navigation](navigation.md)).
- kayjs-mail: a list link with no `KAY_SECRET` is invalid, not a 500; a queued mail keeps one `Message-ID` across retries; a subscriber's id derives from list and address; a list sends at most 300 confirmation mails an hour; `smtps://` is TLS on any port; mail html carries `dir` ([Sending](../packages/mail/llms/writing-and-sending.md)).
- kayjs-cms's edit in place keeps the focus on the element when Enter or Escape ends it, and announces that the text was kept or restored ([Words](../packages/cms/llms/words-media-to-uploads.md)); kayjs-auth groups an organization member's role checkboxes under their name.
- kayjs-ui's error toasts stay until dismissed (`duration` gives them a clock), `HoverCard` describes its anchor and closes on Escape, `ContributionGraph` and a `ScatterChart` without `onSelect` take the arrows, `LoadMore` takes `button` and announces added rows, `Bell` announces a new notification, `VirtualList` requires `label`, and a tooltip repeating its element's name is no longer its description ([Basics](../packages/ui/llms/basics.md), [Charts](../packages/ui/llms/charts-drag-and-media.md)).
- `kay check` lints a `table` with no `th`, a `fieldset` with no `legend`, a hover handler with no focus one, and an email or password `input` with no `autocomplete`, and `kay build` a prerendered page with no `main` or `h1` (`unstructured-page`); the analytics notice carries the `lang` of its words ([Checks](checks.md)).
- kayjs-ui's `Checkbox` and `Slider` take a `ref` on their input as `Toggle` and `ColorInput` do, and the four share one busy, rollback and form-reset helper, so a parent echoing the value from `onChange` or `onInput` is treated alike by all ([Forms](../packages/ui/llms/forms.md)).
- kayjs-ui's `Combobox` list is named by the FormField label as its input is, and `ZoomPane` takes `+ - = 0` and the arrows only when the pane itself has focus, so a field inside it keeps them ([Media](../packages/ui/llms/charts-drag-and-media.md)).
- kayjs-ui's `SplitLayout` on a phone makes the list and detail `inert` under the open sidebar overlay, focuses a pane when it opens and gives focus back when it closes ([Page layout](../packages/ui/llms/page-layout-palette-and-trees.md)).
- kayjs-ui's `MarkdownEditor` preview puts the HTML it is given through `sanitizeHtml`, so a script, handler or `javascript:` link in the text never runs; `previewTrusted` keeps the old insert-as-is for a renderer that sanitizes already ([Forms](../packages/ui/llms/forms.md)).
- kayjs-auth's OAuth server serves and advertises an RFC 7009 revocation endpoint (`/auth/oauth/revoke`), an `oauthServer` with no `scopes` warns at boot, and an organization invitation stops working once its sender can no longer grant it ([OAuth server](../packages/auth/llms/oauth-server-and-tokens.md), [Organizations](../packages/auth/llms/admin-and-organizations.md)).

The rest of this release is in [What's new, older releases](whats-new-archive.md).

Releases before 1.72 are in [What's new, older releases](whats-new-archive.md).
