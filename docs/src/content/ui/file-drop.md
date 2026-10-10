---
description: A drop zone that takes files dropped, picked or pasted.
---

<Demo name="file-drop/basic" />

## The zone

The zone draws whatever the `@content(zone)` block holds. `zone.open()` opens the file picker and `zone.dragging()` reads whether files hover the zone. `onFiles` receives the files that match `accept`, one unless `multiple` is set, and never an empty list.

<Callout type="warning">

FileDrop takes functions, so it renders inside an island: a component with an `on*` handler or a `signal`, as above.

</Callout>

## Previews

A dropped file is a `File`, so `URL.createObjectURL` turns it into an image source with no upload.

<Demo name="file-drop/preview" />

## Pasting

`paste` also takes files pasted anywhere on the page, unless the paste lands in a text field.

<Demo name="file-drop/paste" />
