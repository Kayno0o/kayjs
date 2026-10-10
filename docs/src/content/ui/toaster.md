---
description: Short messages shown above the page and gone after a few seconds.
---

<Demo name="toaster/basic" />

Render one `Toaster` in the root layout, then call `toast.success`, `toast.error` or `toast.info` from an island. A toast stays for four seconds, or until dismissed, and waits while the pointer is on it or focus is inside it.

<Callout type="note">

This page already renders the `Toaster`. `toast` only shows in the browser: the server's list is shared by every request, so call it from event handlers.

</Callout>

## After an action

Call `toast` once what the user started has finished, with the outcome as its type. Here the button fails every other time.

<Demo name="toaster/action" />
