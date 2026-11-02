---
description: A site's icon, or a globe in a colour of its own when it has none.
---

<Demo name="site-favicon/basic" />

## Fallback

The globe shows when `src` is missing or fails to load. In the demo, the first icon loads, the second points to a file that does not exist and the third has no `src`.

<Demo name="site-favicon/fallback" />

## A colour per site

`name` colours the fallback globe, so the same site always gets the same colour and two sites rarely share one.

<Demo name="site-favicon/list" />

## Load, error and a fallback of your own

`onLoad` and `onError` are called with the image's event. `@fallback` draws the icon in place of the globe when there is no image or it fails to load.
