---
description: A form's outcome or a refusal, said in place where the page stays.
---

<Demo name="notice/basic" />

`tone` is `neutral` (the default), `accent`, `info`, `success`, `warning` or `danger`. A danger is an alert, read out at once; the other tones are a status, read once the reader is idle. `label` is the message, and children follow it, such as a link.

## Compact

`size="sm"` drops the box for a line of text, such as under a form's fields.

<Demo name="notice/compact" />

## Over a source

`source` takes anything an island reads that fails: a `resource`, a `stream`, a `track()` handle, a `local` collection or an `infiniteList`. The notice shows while the source's `error()` is set, says the error's message unless `label` does, is a `danger` unless `tone` says, and has a "Try again" button that calls the source's `retry` and waits while its `pending()` is true. It hides again once the source answers. `retryLabel` names the button, and an `@actions` block follows it.

```kay
const notes = resource(api, '/notes')
---
Notice(source={notes})
```
