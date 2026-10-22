# kayjs-ui: Charts, drag and drop, galleries and image tools

## Common tasks

### LineChart, ScatterChart, ContributionGraph

- `LineChart(label="Visits" labels={days} series={[{ name: 'Visits', values: visits }]} xLabels)`, drawn by chartist, a peer the app installs to use it: `bun add chartist`. No other component reaches it.
  - A series has a `name`, one value per label, `null` for a gap in the line (a stacked chart counts it as 0 and draws no gap), and an optional CSS `color`; without one it takes the next `--color-kui-chart-1` to `-6` token. Every line after the first is dashed in its own pattern, which the legend samples, so the series stay apart without their colours.
  - `xLabels` draws up to five x-axis labels, and spaces the points by time when every label is a date. `legend` names the series under the chart, by default once there is more than one. `formatValue` formats the y-axis, the tooltip and what screen readers hear, `toLocaleString` by default; `formatLabel(label, { index, place, span, seconds })` formats a label for the tooltip's heading, the x-axis ticks and what screen readers hear, `place` being `'tooltip'` or `'tick'`, `span` the milliseconds the labels cover (0 when they are not all dates) and `seconds` whether points sit under a minute apart. Without it: by default a date label (`2026-10-21`, or with a time such as `2026-10-21T16:12:12Z`) reads in the page's locale, with its time when it has one and its seconds when points sit under a minute apart, and any other label as written. A date label with a time (read in the viewer's timezone unless it names one) places the points by that moment, and a span under a day labels the x-axis with times; `options` is merged over chartist's settings.
  - Hovering shows a cursor, a dot on each line and a tooltip reading every series at that point, `-` for a gap; the tooltip keeps its natural width and flips below the pointer or shifts to stay inside the viewport. `label` names the chart; screen readers read every value from a table only they see.
  - `stacked` draws each series on top of the ones before it, every line solid since the bands tell them apart (pass a `color` per series beyond six, as the palette cycles too), the band between two lines filled, so the top line reads the total, such as one line per CPU core each its share of the machine. The y-axis starts at 0, lower for a negative total (`options.low` overrides it) and reaches the highest total. The tooltip, the announcements and the table still read each series' own value through `formatValue`, `-` for a `null`, and add a `Total` row or column, which counts a `null` as 0; `totalLabel` renames it, as does the `ui.lineChart.total` word.
  - The plot is a `role="slider"`, one stop in the tab order on the latest point: the arrows walk the points, Home and End reach either end, and each step shows the tooltip and announces the label and every reading. Chords such as Alt with an arrow stay the browser's, and new `labels`, such as after zooming in on a span, drop the point the keyboard stood on.
  - `onRange(from, to)` lets a drag across the plot pick a span, from an island: a band follows the drag, and on release it hands over the indices of the span's first and last points, such as to zoom in on them; a press in place picks nothing. From the keyboard, Shift with the arrows, Home or End stretches the span, Enter hands it over and Escape drops it; `rangeHint` is what screen readers are told about these keys.
  - The server renders its frame, the slider, the table of values, the hint and the legend; the drawing happens once the island mounts. The table holds one row per label, so a series of thousands of points renders as many rows.
- `ScatterChart(label="Games" points={games} x={{ label: 'Hours', scale: 'log', ticks }} y={{ label: 'Score', domain: [0, 100] }} quadrant={{ x: 20, y: 80 }} corners={{ topRight: 'Long and loved' }})`:
  - A point has a `key`, a `label`, `x` and `y`, a `weight` its dot's area follows, and a `tooltip`, the label by default.
  - An axis spans its `domain`, or else the points' own extent, along a `linear` or `log` `scale`, with `ticks` of `{ value, label }` and a `label`. `quadrant` draws guides through a point, and `corners` names the four regions they split.
  - `onSelect(point)` makes each dot a button, from an island; `emptyLabel` is what it reads with no points.
- `ContributionGraph(days={days} color="var(--color-kui-accent)" today={today} months)`: a grid of weeks, each day's cell shaded towards `color` by its `intensity` from 0 to 1, with `description` as hover text before the date, which screen readers read too, or how full the day was (`50% · 2026-09-01`) without one. The grid is a group named by `label`. `days` starts on a Monday: map the dates `gridDays(weeks)` from `@kaynooo/utils/date` lists to `{ day, intensity }`, typed `ContributionDay`; `today` marks its cell, and `months` names each month over the week it starts in. It is static.

### Drag and drop: Sortable, Board, DropTargets

```kay
---
import { Sortable } from '@kaynooo/kayjs-ui/dnd'
import { attempt } from '@kaynooo/kayjs-ui'
import { signal } from 'kay'
import { reorder } from '../routes/habits.kay'

const { habits } = props<{ habits: Habit[] }>()

const rows = signal(habits)
const sortable = new Sortable({
  onReorder: (from, to) => attempt(async () => {
    const next = [...rows()]

    next.splice(to, 0, ...next.splice(from, 1))
    await reorder({ ids: next.map(habit => habit.id) })
    rows.set(next)
  }, 'Could not reorder'),
})
---
ul
  for habit of rows() key={habit.id}
    li(ref={sortable.item(habit.id)})
      button.touch-none(type="button" ref={sortable.handle(habit.id)} aria-label="Move") {habit.name}
```

- Controllers from `@kaynooo/kayjs-ui/dnd`, wired to the app's own markup through `ref`, in an island. A mouse or pen drags after a 10px move and a touch after a 250ms hold, so a swipe still scrolls, and Escape cancels. A scroll container scrolls as the pointer nears its edge. The list changes only once the callback has updated the app's data, and no other move starts until a promise it returns settles: wrap it in `attempt`, since a rejection goes unhandled.
- `Sortable({ onReorder(from, to) })`: a vertical list. `ref={sortable.item(id)}` on each entry and `ref={sortable.handle(id)}` on the part a pointer grabs, which needs `touch-action: none`. A drag slides the other items out of the way; ArrowUp and ArrowDown on a focused handle move its item one place, focus staying on it. A handle with no `role` and no native one gets `role="button"`, and one with no `aria-label`, `aria-labelledby`, text or image with `alt` gets `aria-label` `Reorder {item}`, the item's `aria-label`, first image `alt` or text cut to 40 characters, leaving out the text of the buttons, inputs and selects in it, and following the text as it changes (`Reorder` when it holds none): give the handle your own label to say more.
- `Board({ onMove({ item, from, to, index }) })`: items moving between wrapping containers and within them, for a kanban or a tier list. `ref={board.container(id)}` on each container and `ref={board.item(id, container)}` on each item, grabbed whole. A ghost follows the pointer; `board.dragging()` names the item dragged and `board.drop()` the landing `{ container, index, bar }`, the bar an insertion mark to draw `position: fixed` at `bar.left`, `bar.top` and `bar.height`. ArrowLeft and ArrowRight move a focused item within its container, ArrowUp and ArrowDown into the one before or after.
- `DropTargets({ onDrop(item, target), accepts, onLinger })`: items dropped onto targets, a move that is not a reorder, such as a note into a folder. `ref={targets.item(id)}` and `ref={targets.target(id)}`; the innermost accepting target under the pointer wins, `targets.over()` naming it and `targets.dragging()` the item. `onLinger(target)` runs once the pointer rests on a target, such as to open a folder. Pointers only: give the keyboard a menu or a dialog for the same move.
- A move by key is said to screen readers through one polite live region the page shares, `Moved to {position} of {count}` (the position in the container the item landed in), read from `ui.dnd.moved`. `announce(message, from?)` from `@kaynooo/kayjs-ui/announce` says any message through it, inside the open modal `dialog` holding `from` (the focused element by default) since a modal makes the rest of the page inert, such as for the app's own buttons that move an item.
- A drag cancels the browser's own drag of a link or an image inside the item, and swallows the click its release would send.

### MediaGallery, Carousel, Masonry, WhenVisible, LoadMore, VirtualList, ZoomPane, ImageCropper

- `MediaGallery(items={media})`: a stage, a strip of thumbnails and a lightbox.
  - An item, typed `MediaItem`, has a `key`, a `kind` (`image` or `video`), a `thumb` for the strip, a `preview` for the stage or a video's poster, a `full` the lightbox opens an image at, a video's `src`, its WebVTT `captions` and a `title`.
  - The arrows, Home and End turn it while focus is inside it, wrapping, and so do its buttons and a swipe. `index` is the item to start on, and `onIndexChange(index)` reports each turn. The strip keeps the shown thumbnail centred, and the images either side start loading.
  - A video plays in place with `preload="none"`. An `.m3u8` playlist plays through `hls.js` in browsers without native HLS, fetched only once such a video shows: an optional peer, `bun add hls.js`. An app without it still builds, and a playlist it cannot play logs that hls.js is missing.
  - An image opens full size in a lightbox, which turns the same way. `ratio` is the stage's `aspect-ratio`, `16 / 9` by default; `emptyLabel` is what it reads with no items.
- `Carousel(slides={[{ src: '/garden.jpg', alt: 'The garden' }]} autoplay="5s" ratio="4 / 3" label="Photos")`: one image at a time sliding in, for a marketing page.
  - The previous and next buttons wrap at either end, and a dot per slide jumps to it. A single slide draws no controls. `index` is the slide to start on, followed when the parent passes another, and `onIndexChange(index)` reports each turn.
  - Each slide is a `role="group"` named by `slideLabel`, where `{n}` and `{count}` stand for its number and how many there are; the hidden ones are `aria-hidden` and `inert`.
  - `autoplay` turns it that often, a duration such as `'5s'` or `'800ms'`, held while the pointer or the focus is on it, the tab is hidden or it is scrolled out of view, never for a visitor asking for reduced motion, and stopped once it leaves the page. A pause button after the controls stops it for good, until pressed again.
  - It takes data alone, so a static page holds it.
- `Masonry(items={posts} key={post => post.id} minWidth={256} gap={12})` with a `@tile(item)` block: tiles of any height in as many lanes of at least `minWidth` as fit, each dropped into the shortest lane, the order still reading left to right. The tiles are placed absolutely inside its own box, so padding goes on a wrapper, never on the Masonry; until it has measured, as on the server, they sit in a plain grid of the same lanes.
- `WhenVisible(onVisible={loadMore})`: the infinite-scroll sentinel. Render it after a list only while there is more to load; `onVisible` runs once it comes within `margin` pixels (600) of the nearest scroll box, and again whenever the list grows and leaves it in view, never again before a promise it returned settles.
- `LoadMore(list={people})` after a list, with `const people = infiniteList(firstRows, { pageSize: 20, key: row => row.id, load: ({ offset, last }) => fetchPage(offset) })` from the package, draw `people.rows()`:
  - `pageSize` is a full page: a shorter one ends the list. `load` resolves to the next page, `offset` counting every row fetched and `last` the last row fetched for a cursor source. One page loads at a time.
  - `key` drops a row a later page repeats; leave it out when the source cannot repeat one.
  - A `load` that throws or resolves `undefined` (an `attempt` that toasted) stops the list on an alert with a retry button, loading no other page until it is pressed.
  - It draws the WhenVisible sentinel, a `status` row while a page loads and the alert. `loadingLabel` (`Loading more…`), `failureLabel` (`Could not load more.`), `retryLabel` (`Try again`) and `margin` are its props; `people.ended()`, `failed()` and `pending()` read the state.
- `VirtualList(items={rows} itemKey={row => row.id} label="Messages")` with an `@item(row, index)` block: a long list drawing only the rows in view, with room above and below standing for the others. For `Table`, use its `virtual`.
  - It scrolls in a box of its own, 70vh tall unless the app gives `.kui-virtual-list` another height. Rows of any height are fine: each starts at `estimate` pixels (48) and takes the height it measures, so give `estimate` near the rows' own to keep the scroll bar from moving. `overscan` (4) is the rows drawn beyond the visible ones on each side.
  - `itemKey` keeps a measured height with its row when the list shifts; the index is the key without one. The list is `role="list"` named by `label`, each row a `listitem` with `aria-posinset` and `aria-setsize`, so a screen reader hears the real position.
  - The box takes the focus to scroll by keyboard (arrows, Page Up and Down, Home, End). Find-in-page sees the drawn rows alone, and a focused control in a row that scrolls out of the window loses its focus, so give a long list a filter. A row's height is its border box: space it with padding or a gap, not a margin. The server draws the first screenful only.
- `ZoomPane(label="Floor plan")` around a picture: pinch, Ctrl with the wheel, a double click, + and -, and the zoom buttons take it in, and once in the wheel alone zooms too, while fitted it scrolls the page; Ctrl with + or 0 stays the browser's zoom. A drag or the arrows move it, and 0 or the fit button fits it again. A press that does not wander stays a click, so marks standing on the picture remain clickable; `--kui-zoom-scale` lets one keep its own size with `calc(1 / var(--kui-zoom-scale))`. `tools` draws the buttons, on by default; `most` caps the zoom, 8 times fitted.
- `ImageCropper(src={photo} ratio={16 / 9} onCrop={crop.set})` with an optional `@footer(reset)` block: a crop of a fixed `ratio` over the image, centred once it loads, moved by a drag or the arrows and resized by its corners or Shift with the arrows, Alt taking bigger steps. `onLoad({ width, height })` reports the image's natural size once it has decoded. `onCrop({ x, y, w, h })` reports it in the image's natural pixels, ready for a canvas draw; `grid` adds a rule-of-thirds overlay and `minSize` the smallest side.

## Reference

## Reference

- ContributionGraph's month names and the day and month a LineChart draws on its axis follow the page's locale; `en` keeps `5 Jan`.
