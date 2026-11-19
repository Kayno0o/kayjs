# Upgrading

What each release breaks, and what an app changes to move to it. kay and its libraries share one version, so one section covers them all; a patch breaks nothing, and a version missing here broke nothing. Through 1.x a breaking change ships in a minor; from 2.0.0 it ships in a major, and a minor or a patch breaks nothing.

## 1.111.0

### kay needs Bun 1.4.5

Bun 1.4.5 fixes security issues in HTTP/3, HTTP/1.1, TLS, DNS and Zstandard, which reach `Bun.serve`, `fetch` and `Bun.dns`, so kay and its libraries ask for `bun >=1.4.5` and refuse 1.4.4. Run `bun upgrade`, then `bun update bun` in a project on `bun-plugin-tailwind`, whose peer installs the npm `bun` package that package scripts run ahead of the system Bun, and move CI and images to 1.4.5: `kay upgrade`'s last `kay check --fix` moves a root Dockerfile's `oven/bun` tag (`old-bun-image`).

### kayjs-auth no longer takes `@kaynooo/pg-orm` 7

kayjs-auth's Postgres store writes an OAuth grant with `insertOne`'s `skipConflicts`, which pg-orm 7 lacks, so its peer range is `^8.0.0 || ^9.0.0`. An app on pg-orm 7 moves to 8 or 9 with it (`bun add @kaynooo/pg-orm@^8.0.0`, then pg-orm's `MIGRATION_v8.0.0.md`); kay's own `kay/pg-orm` still takes 7.

### kayjs-ai's Chat is flat and its controls are kayjs-ui's

The panel and the launcher have no shadow by default (`--kai-chat-shadow` still sets one). The suggestions, the edit's Save and Cancel, Try again, Allow and Deny and the conversation list's links are kayjs-ui `Button`s, and a conversation's delete is `ConfirmDelete` asking inline, so the parts `deleteConfirm` and `confirm` are gone: restyle `delete` (the trigger) instead. A `restyle` rule on the chat's own buttons now reaches kayjs-ui's classes. `labels.allowed` and `labels.denied` lose their colon (`Allowed add_note …`), a model prompt reading the old `Allowed:` start needs the new one, and the failure text ends on what to do, `The reply failed. Send your message again.`: set `labels.error` to keep yours.

### A block's or a snippet's plain parameter is read-only in a component that renders again

A `@cell(row)` block or a `snippet show(item)` of an island or a component reads its plain parameters through an accessor, so a block drawn once per key follows the item that replaces it. Writing to one (`item = null` in a handler) is the ``item` is read-only here`` error a loop's row already gives: keep the value in a `signal` of the component and write that. A page or a static component, whose parameters are plain values, is unchanged. `kay check` cannot tell a write meant for the parameter from one meant for a variable of the same name, so no lint rewrites it.

## 1.110.0

### A swap keeps an island whose props changed

- A refresh (an action's, `refresh()`, a live value's) used to end an island whose props changed and hydrate it afresh; it now stays, with its signals, open dialogs and focus, and takes the new props in place. A value the island seeds from a prop once, `signal(light)`, keeps the first value: write `linked(() => light)` for one that follows, or give the island a `persist={key}` that changes to start it afresh. A list whose items move keeps each island by `persist={id}`.
- A visit to a page with the same layout keeps the islands the layout renders (a menu, a folded group) with their state; the page's own islands are still ended. An island of a layout that used to start closed on every page now stays as it was left.
- A refresh keeps a field a visitor typed in and a `details` they toggled unless the server changed that value, where it used to show the server's again.
### A Dialog's close is a plain button with a `close` part

Dialog's close button is a `button` (an `a` with `closeHref`) of the `kui-icon-btn` class drawing the `x` icon, no longer an `IconButton`. An app styling it through `part="root"` of that IconButton, or a `restyle` recipe on `IconButton` that reached it, styles the `close` part of Dialog instead (SidePanel hands it on as its own `close`); a `close` block still replaces the whole button.

Releases before 1.110 are in [Upgrading, older releases](upgrading-archive.md).
