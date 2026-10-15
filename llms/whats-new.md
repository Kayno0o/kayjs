# What's new

What each release of kay and its libraries adds, newest first, each feature with where it is documented. kay and its libraries share one version, so one section covers them all; what a release breaks is in [Upgrading](upgrading.md).

## Unreleased

- kayjs-ui: a `Table` takes `selectable`: a checkbox per row, a tri-state select-all with `N selected`, keys of rows that left `rows` dropped, and a `@bulk(keys, clear)` block for the bulk actions beside the count, in stacked cards too ([kayjs-ui](../packages/ui/llms.txt)).
- kayjs-ui: `infiniteList` and `LoadMore` own an infinite-scroll list's rows, offset or cursor paging, the end of the list, a retry after a failed page and the "Loading more" row, dropping a row already shown when the list shifts ([kayjs-ui](../packages/ui/llms.txt)).
- A `for` over plain objects with no `id`, edited immutably, keeps each row's nodes, fields and focus through an edit, a removal or an insertion, with no id of your own ([Templates](templates.md)).
- A layout declares a `query` of its own, read through `ctx.query` typed and validated with the page's, so the pages under it no longer repeat the schema, and an island's `queryParam` reads it too ([`ctx.query`](routing.md#the-server-fence)).
- A static export writes its endpoint files, sitemap and feeds sixteen at a time, so an endpoint's `GET` no longer runs alone ([Endpoint files](routing.md#endpoint-files)).
- `markInvalid(element, by, invalid)` from `kay` marks a field `aria-invalid` for one source among several, so an island's refused field stays invalid while a kayjs-ui `FormField` still shows a message for it ([Islands](islands.md#forms-posting-in-place)).

## 1.44.0

- kayjs-ui: a `Button` whose `onClick` returns a promise is busy and disabled until it settles, alone among the buttons on one action, and a submit `Button` is busy while its form's async `onSubmit` runs, which marks the form `aria-busy`.
- kayjs-ui: a `FormField` `group` with a message marks its fields `aria-invalid` and described by it, so `focusInvalid` reveals the group's tab and focuses its first field.
- kayjs-auth: an hourly `prune` deletes expired links, codes, invitations and sessions, a session ended by sign-out everywhere or a password change included, and its stores batch reads and deletes into fewer round trips; a custom store implements `prune`, in [1.44.0](upgrading.md#1440).
- kayjs-auth: a data export asks for a sign-in or proof under ten minutes old, an email change on a two-factor account its code, ID tokens need an asymmetric signature and an issuer `https:` in production, and a plain Elysia app refuses cross-site session writes, breaking changes in [1.44.0](upgrading.md#1440).
- kayjs-ui: `Select` and `MultiSelect` take the type of their options' values, a number option handing back a number, a breaking change in [1.44.0](upgrading.md#1440).
- kayjs-ui: `ConfirmDelete` takes `success`, toasted once through, and `tone="neutral"` for a confirm that is not a deletion.
- kayjs-ui: `FileDrop` takes `compact`, a slim row to sit inline in a form.
- kayjs-ui: `TabNav` takes `current={ctx.url}` and `keep`, carrying the named query params onto each tab.
- kayjs-ui: `PageHeader` takes a `@meta` block beside its title and a `description` under it.
- kayjs-ui: `EmptyState` takes `level` to make its title a heading, `level={1}` for an error page.
- kayjs-ui: `Segmented` takes `value={null}` to show no option picked.
- kayjs-ui: a number `TextInput` hands back a number, or `null` once emptied, a breaking change in [1.44.0](upgrading.md#1440).
- AVIF variants encode twice as fast, on kay's own SIMD build of libavif and libaom: [Responsive images](styles-and-assets.md#responsive-images).
- `images.card.logo` draws a square image, an SVG or a raster, at the top left of every share card, `kay check` reporting one the boot would refuse: [Draw a share card for a page](styles-and-assets.md#draw-a-share-card-for-a-page).
- kay's default favicon is a kingfisher on a navy tile, for a site that names none: [Set a favicon and make the site installable](head.md#set-a-favicon-and-make-the-site-installable).
- `kay render <url>` prints what the server answers for one URL, as `kay dev` serves it, without starting it on a port: [Check what a page renders](project.md#check-what-a-page-renders).
- `--format json` on `kay build`, `kay routes`, `kay explain`, `kay fmt` and `kay migrate` prints one JSON document on stdout, as `kay check` does; `kay routes --format json` lists each route with its file, layouts and guards: [Commands](project.md#commands).
- `kay build` in a terminal redraws one line with its step, the step's time and a bar over the routes prerendered and images encoded; piped, it prints the lines it printed before: [Commands](project.md#commands).
- `--quiet` on `kay build`, `kay check`, `kay fmt`, `kay migrate` and `kay new` prints the problems and one summary line, and on `kay dev` the ready line and errors alone: [Commands](project.md#commands).
- `kay dev` lists the errors its servers meet in `.kay/dev/errors.json`, for a reader without a browser, and `kay dev --format json` prints its events as JSON lines: [Commands](project.md#commands).
- `kay dev` in a terminal reads `o` (open), `r` (restart), `c` (clear) and `q` (quit), and under `--host` names its address on the network: [Commands](project.md#commands).
- `watch` and `debounced` from `kay`: `watch` runs on a change only, handed the value before, and `debounced` gives a value once it stops changing: [React to a change, or to typing once it pauses](components.md#react-to-a-change-or-to-typing-once-it-pauses).
- Assigning a signal a component holds in a `const`, an import or a `Signal<T>` prop writes it wherever it was made, `kay check` refusing an assignment to a name holding no signal: [Signals](components.md#signals).
- `workChallenge` and `verifyWork` from `kay/server` put a proof of work in a form field the app's own code checks; kayjs-auth makes it its default CAPTCHA, a breaking change in [1.44.0](upgrading.md#1440): [Proof of work checked in code](actions.md#proof-of-work-checked-in-code).
