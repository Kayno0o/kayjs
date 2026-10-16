---
description: A stage, a strip of thumbnails and a lightbox for images and videos.
---

<Demo name="media-gallery/basic" />

## Items

An item has a `key`, a `kind` of `image` or `video`, a `thumb` for the strip, a `preview` for the stage and a `full` the lightbox opens an image at. A video also takes a `src`, played in place. `ratio` is the stage's `aspect-ratio`.

## Controlled index

`index` is the item to start on and `onIndexChange` reports each turn.

<Demo name="media-gallery/controlled" />

## Items and labels

`items` is the required list, and `empty` is what the gallery reads with none, `No media.` by default.

`previousLabel`, `nextLabel` and `closeLabel` name the lightbox buttons. `openLabel` names the button opening the lightbox, followed by the item's title when it has one, `Open full size` by default. `itemLabel` names an item with no title, `Media {n}`, `{n}` standing for its number.
