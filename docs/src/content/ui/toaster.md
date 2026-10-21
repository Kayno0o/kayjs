---
description: Short messages shown above the page and gone after a few seconds.
---

<Demo name="toaster/basic" />

Render one `Toaster` in the root layout, then call `toast.success`, `toast.error` or `toast.info` from an island. A toast stays for six seconds, an error for ten, or until dismissed, and waits while the pointer is on it or focus is inside it. Screen readers hear it from two status regions the Toaster renders before its popover, kept in the page.

<Callout type="note">

This page already renders the `Toaster`. `toast` only shows in the browser: the server's list is shared by every request, so call it from event handlers.

</Callout>

## How long it stays

`toast.info('Copied', { duration: '3s' })` sets how long a toast stays. `false` keeps it until the reader dismisses it, and each call answers the toast's id, for `dismissToast(id)` to close a sticky one from code. A toast carries a `tone`, `danger`, `success` or `info`; the info toast takes `--color-kui-info`. `type` is the deprecated name of the tone, with `error` for `danger`.

## After an action

Call `toast` once what the user started has finished, with the outcome as its type. Here the button fails every other time.

<Demo name="toaster/action" />

## Showing a failure in the page

`attempt` toasts a failed call. To show its message where it happens instead, in a notice or beside a field, `messageOf(error, fallback)` reads the words the route answered with, or an action's refusal, when they read as a message, and gives `fallback` for a network failure, a 5xx or any other error.

## Dismiss label and hotkey

`dismissLabel` names each toast's close button for screen readers, `Dismiss notification` by default.

`hotkey` is the key that, with Alt, moves the focus to the first toast's close button, `t` by default. Pass `hotkey={null}` to turn it off.
