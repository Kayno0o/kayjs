---
description: Polylines and markers over raster tiles, fitted to what they draw, drawn by Leaflet.
---

<Demo name="map/basic" />

<Callout type="note">

The map is drawn by Leaflet, which the app installs with `bun add leaflet @types/leaflet`. The server renders the frame and the list screen readers read, and Leaflet loads once the island mounts, so a page without a map downloads none of it. OpenStreetMap's tiles come from an `https` host, which kay's default Content-Security-Policy already admits for images; an app that narrows `img-src` adds its tile host there.

</Callout>

## Lines and markers

`lines` is an array of paths, each an array of `[latitude, longitude]` points, and `markers` an array of `{ at, label, popup }`. The map fits what it draws, and shows the `center` at `zoom` while there is nothing yet. A marker with a `label` shows it on hover and lists it for screen readers, and a `popup` opens on a click as plain text. A point that is no place, such as a `NaN`, is left out.

## Highlighting a path

`highlight` is a path, drawn over the lines on a dark casing and brought into view, such as the entry picked in a timeline. A single point draws a dot. Unset, the map fits everything again. It follows the value it is given, so a signal's current value moves it.

<Demo name="map/highlight" />

## Tiles

`tiles` is the tile layer's URL template and `attribution` the credit shown in the corner, OpenStreetMap's by default. Set the two together, and `maxZoom` to what the tiles reach.

## Look and screen readers

The controls, tooltips, popups and attribution take the skin's colours, and the lines the accent, in light and dark. `--map-height` sets the height, 24rem by default. `label` names the map as a region for screen readers, and the markers' labels are read from a list only they see. The keyboard moves the map with the arrows and zooms with `+` and `-`.
