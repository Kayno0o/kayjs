---
description: The island inside Bell that draws the list, from the inbox or from a source of your own.
---

`BellInbox` is what `Bell` renders. With no `items` it reads and updates the signed-in visitor's inbox over `/_kay/ui/inbox`; use [Bell](/ui/bell) for that, which shows nothing to a visitor who is not signed in.

Use `BellInbox` inside an island when your notifications live elsewhere and load in the browser. `items` is a list or a function returning a list or a promise of one, asked when the component loads, again when a signal it reads changes and after every read. `unread` sets the count, the unread items by default.

`onRead(id)` hears an item opened, and `onRead(undefined)` hears "Mark all as read". It is where your own source marks the read, and a promise is awaited before the list is asked again. Without `onRead` a custom source draws no "Mark all as read".

`onOpenChange(open)` hears the list shown or hidden, and `open` shows it from the page. `@item(note)` draws a row in place of its dot and title, and the row stays the link or button that reads the item. A title is text, and a link is drawn only for a path of your site or an http or https address.
