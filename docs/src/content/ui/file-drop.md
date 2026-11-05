---
description: A drop zone that takes files dropped, picked or pasted.
---

<Demo name="file-drop/basic" />

## The zone

The zone draws whatever the `@content(zone)` block holds. `zone.open()` opens the file picker and `zone.dragging()` reads whether files hover the zone. `onFiles` receives the files that match `accept`, one unless `multiple` is set, and never an empty list.
`onReject(files, reason)` receives the dropped or picked files left out, once per reason: `type` for those that miss `accept`, `size` for those past `maxSize`, `count` for the matching ones beyond `maxFiles` or, without `multiple`, the first.

Without an `@content` block, the zone shows a button that opens the picker and a line about dropping, so the keyboard reaches it.

<Callout type="warning">

FileDrop takes functions, so it renders inside an island: a component with an `on*` handler or a `signal`, as above.

</Callout>

## In a form

`name` makes the zone a form control. It keeps the files on its input, so a plain form posts them to an action's `s.File()` or `s.Files()`, and `onFiles` becomes optional. `maxSize` takes bytes or a string such as `'2mb'`, and `maxFiles` the most files kept. `list` shows the kept files under the zone, each with a button to remove it, and `onChange` hears the list change. A form reset empties it.

The zone picks files once the page is interactive, as its input is hidden and the content opens it. A form that must work without JavaScript uses a plain `input(type="file" name="photos")` instead.

`invalid` marks the zone as refused. `issue`, or a message the action refused `name` with, shows under the zone and marks it too.

<Demo name="file-drop/form" />

## Previews

A dropped file is a `File`, so `URL.createObjectURL` turns it into an image source with no upload.

<Demo name="file-drop/preview" />

## Compact

`size="sm"` draws the zone as a slim row, its content from the left, to sit beside other fields in a form.

<Demo name="file-drop/compact" />

## Pasting

`paste` also takes files pasted anywhere on the page, unless the paste lands in a text field.

<Demo name="file-drop/paste" />

## Disabled

`disabled` stops the zone taking files, dropped, picked or pasted. It is false by default.
