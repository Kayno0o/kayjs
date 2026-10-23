# Texts and languages

Every text kayjs-ui shows by default is looked up in the app's catalogs (`src/messages/<locale>.ts`) under a `ui.<component>.<prop>` key before its English, through `wording` from `kay/words`. kayjs-ui ships the French of every key, read on a page whose locale is `fr` (`fr-CA` and the like included) after the app's own catalog, with no setup: a site on `lang: 'fr'` with no `src/messages` reads French defaults. Any other locale, and a key the app words itself, reads the app's catalog, then the English below.

## Common tasks

### Word a text for the whole site

Put the message under its `ui.<component>.<prop>` key in the locale's file:

```ts
// src/messages/fr.ts
ui: { sidePanel: { close: 'Fermer' } }
```

## Reference

- Word a text once for the whole site, in the locale's file: `ui: { sidePanel: { close: 'Fermer' }, pagination: { previous: 'Précédent', next: 'Suivant' } }`. Every instance of the component reads it, an island's included.
- The key is the component's name in camel case, then the prop that sets the text: `SidePanel`'s `closeLabel` is `ui.sidePanel.close`. A prop given to the component replaces the message and the English both.
- Keys carry no `Label` suffix since 1.72 (`ui.table.filter`, not `ui.table.filterLabel`), though the props keep their names; a catalog still wording the old key wins until 1.75, and `kay check --fix` renames it (`deprecated-message-key`). Where a visible text had the name, the accessible one ends in `Aria` (`cms.table.moveUpAria`).
- A message may hold the placeholders its English shows, `{n}` or `{count}`, and a count may be written as plural forms: `rowCount: { one: '{count} ligne', other: '{count} lignes' }`.
- The French lives in `src/messages/fr.ts` of the package, declared by `"kay": { "messages": "./src/messages" }` in its package.json; an app overrides any key in its own `src/messages/fr.ts`, which lays over it key by key.
- `kay check` leaves `ui.*` keys out of its comparison between locales, so a French block needs no English twin; a key a locale lacks reads the English.
- CommandPalette's `recentLabel` names the heading the recently followed links sit under.
- ContributionGraph's month names and the day and month a LineChart draws on its axis follow the page's locale; `en` keeps `5 Jan`.
- Rating's `{value}` and `{max}` and RangeInput's and DateRangeInput's `{label}` fill the messages of the same name.
- ContactForm's labels read `ui.contactForm.*`, then kayjs-mail's `mail.contact.form.*` messages (English and French) before the English, and MarkdownEditor's `Uploading name…` marker, a placeholder in the text until the upload ends, stays English.
- Texts the app's data owns, a `failure`, a `message` or a `label` it passes, are the app's to word.
- Messages about the app's data are its own, passed as props (`failure`, `message`, `label`). The library's own words (`Close`, `Cancel`, `Loading…`...) are looked up in the app's catalogs under `ui.<component>.<prop>` keys, `ui.sidePanel.close`, before their English, and a prop given to the component replaces both. The French of every key ships with the library and is read on a French page with no setup.

### The keys

- `ui.barChart.*`: `empty` (`No data yet.`), `total` (`Total`)
- `ui.barList.*`: `empty` (`No data yet.`)
- `ui.bell.*`: `empty` (`No notifications`), `label` (`Notifications`), `markAll` (`Mark all as read`), `unread` (`{label}, {count} unread`, `{label}, 1 unread` for one), `unreadMark` (`(unread)`, read by screen readers beside an unread item)
- `ui.carousel.*`: `dot` (`Go to slide {n}`), `label` (`Carousel`), `next` (`Next slide`), `pause` (`Pause`), `play` (`Play`), `previous` (`Previous slide`), `slide` (`Slide {n} of {count}`)
- `ui.combobox.*`: `create` (`Create "{text}"`), `empty` (`No match`), `failure` (`Could not load the options`), `loading` (`Loading…`), `results` (`{count} results`, `1 result` for one)
- `ui.commandPalette.*`: `empty` (`No results`), `label` (`Search`), `placeholder` (`Search`), `recent` (`Recent`), `results` (`{count} results, `1 result` for one`), `siteSearchError` (`The pages could not be searched`), `siteSearch` (`In the pages`), `siteSearchMore` (`{count} more matches`, `1 more match` for one)
- `ui.confirmDelete.*`: `cancel` (`Cancel`), `confirm` (`Confirm`), `delete` (`Delete`), `pending` (`Deleting…`), `title` (`Confirm Deletion`)
- `ui.contactForm.*`: `consent` (`I agree that my details are used to answer my message.`), `email` (`Email`), `message` (`Message`), `name` (`Name`), `privacy` (`Privacy policy`), `sent` (`Thank you, your message has been sent.`), `submit` (`Send`)
- `ui.contributionGraph.*`: `label` (`Contributions`)
- `ui.copyButton.*`: `copied` (`Copied!`), `failure` (`Could not copy to the clipboard`)
- `ui.dateInput.*`: `next` (`Next month`), `open` (`Choose a date`), `previous` (`Previous month`), `today` (`Today`)
- `ui.dateRangeInput.*`: `from` (`{label} from`), `to` (`{label} to`)
- `ui.dnd.*`: `handleItem` (`Reorder {item}`), `handle` (`Reorder`), `moved` (`Moved to {position} of {count}`)
- `ui.formDialog.*`: `cancel` (`Cancel`), `saving` (`Saving…`)
- `ui.iconPicker.*`: `clear` (`Clear icon selection`), `empty` (`No icons found.`), `error` (`The icons could not be loaded.`), `grid` (`Icons`), `more` (`Show more`), `placeholder` (`Search icons…`), `search` (`Search icons`), `searching` (`Searching…`)
- `ui.imageCropper.*`: `crop` (`Crop area: arrows move it, Shift and the arrows resize it`), `cropText` (`{w} by {h} pixels at {x}, {y}`)
- `ui.lineChart.*`: `rangeHint` (`Shift with the arrow keys picks a span, Enter applies it, Escape drops it`), `total` (`Total`)
- `ui.loadMore.*`: `failure` (`Could not load more.`), `loading` (`Loading more…`), `retry` (`Try again`)
- `ui.markdownEditor.*`: `bold` (`Bold`), `bulletList` (`Bulleted list`), `heading` (`Heading`), `image` (`Image`), `italic` (`Italic`), `keysHint` (`Tab indents a list item; Escape then Tab leaves the field.`), `link` (`Link`), `numberedList` (`Numbered list`), `placeholder` (`Write markdown…`), `preview` (`Preview`), `previewFailure` (`The preview could not be shown`), `toolbarFailure` (`The toolbar could not be loaded`), `toolbar` (`Formatting`), `uploadFailure` (`Could not upload the image`)
- `ui.mediaGallery.*`: `close` (`Close`), `empty` (`No media.`), `item` (`Media {n}`), `next` (`Next`), `open` (`Open full size`), `previous` (`Previous`)
- `ui.multiSelect.*`: `all` (`All`), `empty` (`No match`), `none` (`None`), `placeholder` (`Any`), `search` (`Search`), `selected` (`{count} selected`)
- `ui.pagination.*`: `label` (`Pagination`), `next` (`Next`), `previous` (`Previous`)
- `ui.rangeInput.*`: `from` (`{label} from`), `to` (`{label} to`)
- `ui.rating.*`: `label` (`{value} out of {max}`)
- `ui.saveForm.*`: `clean` (`No unsaved change.`), `dirty` (`Unsaved changes.`), `discard` (`Discard`), `failure` (`Could not save.`), `save` (`Save`), `saving` (`Saving…`)
- `ui.scatterChart.*`: `empty` (`No data yet.`)
- `ui.select.*`: `loading` (`Loading…`)
- `ui.sidePanel.*`: `close` (`Close`)
- `ui.siteNav.*`: `menu` (`Menu`)
- `ui.splitLayout.*`: `back` (`Back`), `resize` (`Resize list`)
- `ui.steps.*`: `done` (`completed`)
- `ui.table.*`: `export` (`Export CSV`), `filter` (`Filter`), `rowCount` (`{count} rows, `1 row` for one`), `selectAll` (`Select all`), `selectRow` (`Select {row}`), `selected` (`{count} selected`)
- `ui.toaster.*`: `dismiss` (`Dismiss notification`)
- `ui.zoomPane.*`: `fit` (`Fit`), `zoomIn` (`Zoom in`), `zoomOut` (`Zoom out`)
