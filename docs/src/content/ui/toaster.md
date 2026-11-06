---
description: Short messages shown above the page and gone after a few seconds, an error staying until dismissed.
---

<Demo name="toaster/basic" />

Render one `Toaster` in the root layout, then call `toast.success`, `toast.error` or `toast.info` from an island. A toast stays for six seconds and an error until it is dismissed, unless a `duration` says otherwise, and waits while the pointer is on it or focus is inside it. Screen readers hear it from two status regions the Toaster renders before its popover, kept in the page.

<Callout type="note">

This page already renders the `Toaster`. `toast` only shows in the browser: the server's list is shared by every request, so call it from event handlers.

</Callout>

## How long it stays

`toast.info('Copied', { duration: '3s' })` sets how long a toast stays. `false` keeps it until the reader dismisses it, and each call answers the toast's id, for `dismissToast(id)` to close a sticky one from code. A toast carries a `tone`, any of `neutral`, `accent`, `success`, `warning`, `danger` or `info`, and `toast.warning(...)` pushes a warning one; the info toast takes `--color-info`. `type` is the deprecated name of the tone, with `error` for `danger`.

## A second line, markup and what happened to it

`description` adds a quieter line under the message, and `message` may be markup instead of a string. `onDismiss(reason)` is called once a toast has gone, with `timeout`, `user` (the close button or Escape), `action` (its button ran) or `api` (`dismissToast(id)`, or `toast.update`): `toast.info('Exported', { description: '12 rows', onDismiss: reason => track(reason) })`.

## Changing a toast that is open

`toast.update(id, { message, description, tone, action, duration })` changes it in place and answers `false` when it already went. Naming `tone` or `duration` starts its clock afresh.

## Following a call

`toast.promise(upload(), { loading: 'Uploading', success: file => `Uploaded ${file.name}`, error: 'Could not upload' })` shows a spinner toast, then turns the same toast into the outcome, an error staying until it is dismissed. Give it a promise or a function returning one. It resolves to the value, or to `undefined` when the call threw, so it needs no `catch`.

## Position, limit and your own toast

`Toaster(position="top-center" limit={3})` stacks the toasts against another corner or edge (`top-left`, `top-center`, `top-right`, `bottom-left`, `bottom-center`, `bottom-right`) and shows the newest three, the others waiting with their clocks running. An action may be a link, `{ label: 'Open', href: '/exports/12' }`. To draw the inside of each toast yourself, give the Toaster a block: `@toast(item, dismiss)`, where `dismiss` closes the toast.

## After an action

Call `toast` once what the user started has finished, with the outcome as its type. Here the button fails every other time.

<Demo name="toaster/action" />

## A button in the toast

`toast.error('Could not pull', { action: { label: 'Rebase', run: rebase } })` adds one button before the close button, for the obvious next step. It is busy while `run` is pending, and the toast goes once it settles. A `run` that rejects is logged. A toast with an action keeps the clock of its tone, so an error stays until it is dismissed.

`attempt` gives a refusal's toast one with `refusedAction`, which reads the same data as `refused`: `attempt(run, { failure, refused: data => data.error, refusedAction: data => data.diverged ? { label: 'Rebase', run: rebase } : undefined })`. A `failure` gets none, and neither does a refusal given to `onRefused`, which shows no toast.

## Showing a failure in the page

`attempt` toasts a failed call. To show its message where it happens instead, in a notice or beside a field, `messageOf(error, fallback)` reads the words the route answered with, or an action's refusal, when they read as a message, and gives `fallback` for a network failure, a 5xx or any other error.

To keep what a refusal carries instead of its words, such as the output of a command, give `attempt` an `onRefused`: `attempt(run, { failure, onRefused: data => output = data.output })`. It gets the data an action's handler passed to `ctx.fail`, or the JSON a route answered with, and nothing is toasted.

`onRefused` is awaited, and one that throws or rejects is logged and toasts `failure`. A failure that is no refusal, such as a network error or a 5xx answer, still toasts `failure`, and `attempt` resolves to `undefined` either way.

## Dismiss label and hotkey

`dismissLabel` names each toast's close button for screen readers, `Dismiss notification` by default.

`hotkey` is the key that, with Alt, moves the focus to the first toast's first button, its action when it has one, `t` by default. Pass `hotkey={null}` to turn it off.

Other attributes, such as a `data-testid` or an `aria-label`, go on the toast stack's element.
