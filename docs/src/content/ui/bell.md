---
description: An icon button with the signed-in visitor's unread notification count and a list of them.
---

Put a `Bell` in a layout. It draws nothing for a visitor who is not signed in. For a signed-in one it shows the unread count on an icon button, and opening it lists the newest notifications: opening one marks it read and follows its link, and "Mark all as read" marks the rest. Every open tab updates when a notification arrives.

Notifications are stored on the server with `notify(userId, { title, url })` from `kay/server`. See [Notifications](/guides/live-and-realtime#notifications).

## Who sees what

A `Bell` has no `user` prop. It reads the signed-in user on the server, from the auth library, so one visitor never sees another's notifications. A page with a `Bell` is private and rendered for each request.

## Label and placement

`label` names the button, `Notifications` by default, and with unread notifications it also says how many. `placement` is where the list opens from the button, `bottom-end` by default.

A notification that arrives while the page is open is announced to screen readers. A title is shown as text. A link is drawn only when it is a path of your site or an http or https address, and an outside address opens in a new tab.
