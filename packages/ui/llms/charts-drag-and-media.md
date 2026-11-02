# kayjs-ui: Drag and drop, galleries and image tools

## Common tasks

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
    rows = next
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
- A move by key is said to screen readers through one polite live region the page shares, `Moved to {position} of {count}` (the position in the container the item landed in), read from `ui.dnd.moved`. `announce(message, from?)` from `@kaynooo/kayjs-ui/announce` says any message through it, inside the open modal `dialog` holding `from` (the focused element by default) since a modal makes the rest of the page inert, such as for the app's own buttons that move an item. The region outlives a page swap, so a message said just before one is still read.
- A drag cancels the browser's own drag of a link or an image inside the item, and swallows the click its release would send.

### MediaGallery, Carousel, AudioPlayer, Masonry, WhenVisible, VirtualList, ZoomPane, ImageCropper

- `MediaGallery(items={media})`: a stage, a strip of thumbnails and a lightbox.
  - An item, typed `MediaItem`, has a `key`, a `kind` (`image` or `video`), a `thumb` for the strip, a `preview` for the stage or a video's poster, a `full` the lightbox opens an image at, a video's `src`, its WebVTT `captions` and a `title`.
  - The arrows, Home and End turn it while focus is inside it, wrapping, and so do its buttons and a swipe. `index` is the item to start on, and `onIndexChange(index)` reports each turn. The strip keeps the shown thumbnail centred, and the images either side start loading.
  - A video plays in place with `preload="none"`. An `.m3u8` playlist plays through `hls.js` in browsers without native HLS, fetched only once such a video shows: an optional peer, `bun add hls.js`. An app without it still builds, and a playlist it cannot play logs that hls.js is missing.
  - An image opens full size in a lightbox, which turns the same way. `ratio` is the stage's `aspect-ratio`, `16 / 9` by default; `emptyLabel` is what it reads with no items.
- `Carousel(slides={[{ src: '/garden.jpg', alt: 'The garden' }]} autoplay="5s" ratio="4 / 3" label="Photos")`: one image at a time sliding in, for a marketing page.
  - The previous and next buttons wrap at either end, and a dot per slide jumps to it. A single slide draws no controls. `index` is the slide to start on, followed when the parent passes another, and `onIndexChange(index)` reports each turn.
  - Each slide is a `role="group"` named by `slideLabel`, where `{n}` and `{count}` stand for its number and how many there are; the hidden ones are `aria-hidden` and `inert`.
  - `autoplay` turns it that often, a duration such as `'5s'` or `'800ms'`, held while the pointer or the focus is on it, it is scrolled out of view, or the tab is hidden (it then turns once as the tab shows again), never for a visitor asking for reduced motion, and stopped once it leaves the page. A pause button after the controls stops it for good, until pressed again.
  - It takes data alone, so a static page holds it.
- `AudioPlayer(src="/episode.mp3" title="Episode 12" chapters={chapters} cues={cues})`: an audio player drawn in the library's look, with no native controls: play and pause, a time and a slider that seeks (arrows, Home, End and Page keys, spoken as `0:12 / 2:00`).
  - `chapters` (`AudioChapter` from the package: `title`, `start` in seconds, optional `url`) are in time order, as the player never sorts them. They are a list of buttons that seek and play, marks on the timeline, and the steps of the previous and next buttons, which appear from two chapters; the one playing is `aria-current` and named under the bar. A chapter with a `url` gets a link beside it, in a new tab when it is another site.
  - `cues` (`AudioCue`: `start`, `end`, `text`) fill a transcript in a folded section, grouped under the chapter they start in. The cue playing is `aria-current` and kept in view in the transcript's own scroll box, and a click on a cue seeks there and plays. The cues are one tab stop and the arrows go between them, the horizontal ones following the reading direction.
  - Once played, the lock screen and headset show the chapter as the title (`title` as the album, with `artist` and `artwork`), the previous button restarts a chapter past its first 3 seconds and else goes to the one before, and next goes on; the lock screen's seek works too. The handlers go when the player leaves the page.
  - `@actions(chapter, index)` fills each chapter's row after its link, for the app's own buttons. `position` (seconds) is followed when the parent passes one more than a second from the audio's own, and `onPositionChange(seconds)` and `onChapterChange(index)` (-1 before the first chapter) report the playing, so `position={at()} onPositionChange={at.set}` binds it; a position the player reported in the last second is taken as the parent echoing it back and never seeks, though an echo later than that seeks backwards. Next is disabled on the last chapter.
  - `preload` is `metadata` by default, which gives the length for the slider; a source whose length is unknown draws a disabled slider. A refused play toasts `failure`. The words are `playLabel`, `pauseLabel`, `previousLabel`, `nextLabel`, `seekLabel`, `chaptersLabel`, `transcriptLabel`, `linkLabel` (`{title}`) and `failure`. It renders as an island, taking functions. Its parts are `root`, `audio`, `bar`, `step`, `play`, `time`, `seek`, `track`, `marks`, `mark`, `now`, `chapters`, `chapter`, `jump`, `start`, `title`, `actions`, `transcript`, `group`, `groupTitle`, `cues` and `cue` ([Restyle a component](restyle.md)).
- `Masonry(items={posts} key={post => post.id} minWidth={256} gap={12})` with a `@tile(item)` block: tiles of any height in as many lanes of at least `minWidth` as fit, each dropped into the shortest lane, the order still reading left to right. The tiles are placed absolutely inside its own box, so padding goes on a wrapper, never on the Masonry; until it has measured, as on the server, they sit in a plain grid of the same lanes.
- `WhenVisible(onVisible={loadMore})`: the infinite-scroll sentinel. Render it after a list only while there is more to load; `onVisible` runs once it comes within `margin` pixels (600) of the nearest scroll box, and again whenever the list grows and leaves it in view, never again before a promise it returned settles.
- `LoadMore(list={people})` after a list loaded page by page, from `infiniteList`: [Infinite lists, LoadMore and a Table over them](infinite-list.md).
- `VirtualList(items={rows} itemKey={row => row.id} label="Messages")` (`label` is required) with an `@item(row, index)` block: a long list drawing only the rows in view, with room above and below standing for the others. For `Table`, use its `virtual`.
  - It scrolls in a box of its own, 70vh tall unless the app gives `.kui-virtual-list` another height. Rows of any height are fine: each starts at `estimate` pixels (48) and takes the height it measures, so give `estimate` near the rows' own to keep the scroll bar from moving. `overscan` (4) is the rows drawn beyond the visible ones on each side.
  - `itemKey` keeps a measured height with its row when the list shifts; the index is the key without one. The list is `role="list"` named by `label`, each row a `listitem` with `aria-posinset` and `aria-setsize`, so a screen reader hears the real position.
  - The box takes the focus to scroll by keyboard (arrows, Page Up and Down, Home, End). Find-in-page sees the drawn rows alone, and a focused control in a row that scrolls out of the window loses its focus, so give a long list a filter. A row's height is its border box: space it with padding or a gap, not a margin. The server draws the first screenful only.
- `ZoomPane(label="Floor plan" plate={view()} onChange={view.set})` around a picture (`plate` `{ scale, x, y }` is followed when the parent changes it, `{ scale: 1, x: 0, y: 0 }` fits): pinch, Ctrl with the wheel, a double click, + and -, and the zoom buttons take it in, and once in the wheel alone zooms too, while fitted it scrolls the page; Ctrl with + or 0 stays the browser's zoom. The keys act only when the pane itself has focus, so a field or radio group inside it keeps them. A drag or the arrows move it, and 0 or the fit button fits it again. A press that does not wander stays a click, so marks standing on the picture remain clickable; `--zoom-scale` lets one keep its own size with `calc(1 / var(--zoom-scale))`. `tools` draws the buttons, on by default; `most` caps the zoom, 8 times fitted, and `least` takes it out (1 by default, fitted; 0.5 lets the plate shrink to half the pane). `onChange({ scale, x, y })` runs on every pan or zoom, `x` and `y` being where the plate's top-left corner sits in pixels, so a card or ring standing on it can follow.
- `ImageCropper(src={photo} ratio={16 / 9} onCrop={crop.set})` with an optional `@footer(reset)` block: a crop of a fixed `ratio` over the image, centred once it loads, moved by a drag or the arrows and resized by its corners or Shift with the arrows, Alt taking bigger steps. `onLoad({ width, height })` reports the image's natural size once it has decoded. `onCrop({ x, y, w, h })` reports it in the image's natural pixels, ready for a canvas draw, on every move of a drag; `onCropEnd(crop)` once a drag that moved it is released, after each arrow press and after the footer's `reset()`, for saving. `crop` starts it, and moves it when it changes, clamped to the image and `ratio` (`onCrop` hears the clamped one when it differs). `onError()` runs when the image does not load, and `errorLabel` or a `@fallback` block shows instead of it. `grid` adds a rule-of-thirds overlay and `minSize` the smallest side.

## Reference

- Sortable, Board and DropTargets, the gallery components and ZoomPane are described above; the charts and MapView are in [Charts and MapView](charts.md).
