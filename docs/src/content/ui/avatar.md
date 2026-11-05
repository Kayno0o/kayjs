---
description: A person's picture, or the initial of their name on a colour of its own.
---

<Demo name="avatar/basic" />

`name` seeds the fallback's colour and gives its initial, shown when `src` is missing or fails to load, so one name always gets the same colour. `label` names the avatar for screen readers; without it the avatar is decorative, for when the name is written beside it.

## Sizes

`size` is `xs`, `sm`, `md` (the default) or `lg`.

<Demo name="avatar/sizes" />

## Load, error and a fallback of your own

`onLoad` is called with the picture's event and `onError` with `{ event }`. `@fallback` draws the avatar in place of the name's initial when there is no picture or it fails to load.
