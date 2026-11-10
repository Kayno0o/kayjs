---
description: A person's picture, or the initial of their name on a colour of its own.
---

<Demo name="avatar/basic" />

`name` seeds the fallback's colour and gives its initial, shown when `src` is missing or fails to load, so one name always gets the same colour. `label` names the avatar for screen readers; without it the avatar is decorative, for when the name is written beside it.

## Sizes

`size` is `xs`, `sm`, `md` (the default), `lg` or `xl`.

<Demo name="avatar/sizes" />

## Status

`status` draws a presence dot in the picture's corner: `online`, `away`, `busy` or `offline` (hollow). The state is part of the avatar's accessible name, `Ada, online`, from the `ui.avatar.<status>` messages, so it is read out and not shown by colour alone; `statusLabel` words it for one avatar. To show several people at once, see [AvatarGroup](/ui/avatar-group).

<Demo name="avatar/status" />

## Load, error and a fallback of your own

`onLoad` is called with the picture's event and `onError` with `{ event }`. `@fallback` draws the avatar in place of the name's initial when there is no picture or it fails to load.
