---
description: Polylines and markers over raster tiles, fitted to what they draw, drawn by Leaflet.
---

<Demo name="map-view/basic" />

<Callout type="note">

The map is drawn by Leaflet, which the app installs with `bun add leaflet`, with no types package needed. The server renders the frame and the list screen readers read, and Leaflet loads once the island mounts, so a page without a map downloads none of it. OpenStreetMap's tiles come from an `https` host, which kay's default Content-Security-Policy already admits for images; an app that narrows `img-src` adds its tile host there.

</Callout>

## Lines and markers

`lines` is an array of paths, each an array of `[latitude, longitude]` points, and `markers` an array of `{ at, label, popup }`. The map fits what it draws, and shows the `center` at `zoom` while there is nothing yet. A marker with a `label` shows it on hover or focus, as text, and lists it for screen readers, and a `popup` opens on a click as plain text and is listed with its marker. A point that is no place, such as a `NaN`, is left out.

When `lines` or `markers` change, the map fits them again, unless the visitor panned or zoomed it since: their view then stays.

## Highlighting a path

`highlight` is a path, drawn over the lines on a dark casing and brought into view, such as the entry picked in a timeline. A single point draws a dot. Unset, the map fits everything again. It follows the value it is given, so a signal's current value moves it.

<Demo name="map-view/highlight" />

## Clicks, moves and popup content

`onMarkerClick(marker, index)` is called as a click, Enter or Space presses a marker, besides opening its popup; a marker with the callback is clickable and a tab stop even with no label or popup. `onMove({ center, zoom })` hears the visitor's own pans and zooms, not a fit the map makes nor a view the parent set.

`center` and `zoom` are followed: a new value moves the map there, and counts as the visitor's own move, so later changes to the lines or markers no longer refit it. A parent that keeps the view in a signal writes `onMove={view => { center = view.center; zoom = view.zoom }}`; the view it passes back is the view the map already has.

The `popup(marker, index)` block draws a marker's popup in place of its `popup` text, so it can hold a link or a button. Its content sits in the screen-reader list and moves into the popup while it is open; a block that draws nothing for a marker leaves that marker with no popup.

```kay
MapView(label="Route" markers={stops} onMarkerClick={(stop, index) => selected = index})
  @popup(stop, index)
    a(href={`/stops/${index}`}) Open {stop.label}
```

## Tiles

`tiles` is the tile layer's URL template and `attribution` the credit shown in the corner, OpenStreetMap's by default. Set the two together, and `maxZoom` to what the tiles reach. The map follows a change to any of them.

Raster tiles are drawn light, so while the map's colour scheme is dark, whether from the system or a `data-theme` around it, a filter darkens them. `--map-tiles-dark` replaces that filter, and `none` keeps the tiles light. A tile set of its own for dark goes in `darkTiles`, drawn in place of `tiles` with no filter and credited with `darkAttribution`, the `attribution` by default.

## Look and screen readers

The controls, tooltips, popups and attribution take the skin's colours, and the lines the accent, in light and dark. `--map-height` sets the height, 24rem by default, and `--map-casing` the colour under a highlight, black by default.

Fits skip their animation for visitors who prefer reduced motion, and a map mounted in a hidden tab fits once it is shown. `label` names the map as a region for screen readers, and the markers' labels are read from a list only they see.

The keyboard moves the map with the arrows and zooms with `+` and `-`. The markers with a label or a popup are one tab stop after it: the arrows and Home and End walk them in the order of `markers`, each showing its label and panned into view, Enter or Space toggles its popup and Escape closes it.
