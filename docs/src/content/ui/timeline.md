---
description: A vertical list of time-stamped entries, one of which can be picked.
---

<Demo name="timeline/basic" />

Each entry has a `key`, a `time` (a time or a range, worded as you like), a `text`, and optionally an `icon` and a `tone`. The entries show in the order you pass them, so pass them in time order. `label` names the list for screen readers.

## Tones

`tone="muted"` greys an entry, such as a gap nothing reported. `accent`, `success`, `warning`, `danger` and `info` colour its icon.

## Picking an entry

With `onSelect` or `selected`, every entry becomes a button. One is picked at a time and marked with `aria-pressed`, and pressing it again clears the pick. `selected` is the picked key, so `selected={picked()} onSelect={picked.set}` binds it. `onSelect` gets the key, or `undefined` when the pick was cleared, then the entry.

An entry with `pickable: false` stays plain text, such as a gap with nothing to show elsewhere.
