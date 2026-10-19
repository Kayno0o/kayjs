---
description: A small label for a status, a tag or a count.
---

<Demo name="badge/basic" />

## Tones

`tone` colors the badge: `neutral` (the default), `accent`, `success`, `warning`, `danger` or `info`.

<Demo name="badge/tones" />

## Solid

Set `solid` to fill the badge with its tone. The text takes `--color-kui-on-accent`, which every tone reads at 4.5:1 in both color schemes, and a skin can change it with `--kui-badge-solid-text`.

<Demo name="badge/solid" />

## Icons and counts

`icon` draws one of the library's icons before the label, and `label` also takes a number for a count.

<Demo name="badge/icon" />

## Stamp

Set `stamp` to draw the badge as a rubber stamp: a hairline in its text color and small spaced capitals. It fills again while a `.group` holding it is hovered. A stamp is never solid.
