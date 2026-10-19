# Texts and languages

Every text kayjs-ui shows by default is looked up in the app's catalogs (`src/messages/<locale>.ts`) under a `ui.<component>.<prop>` key before its English, through `wording` from `kay/words`. A site without the keys renders the English below, unchanged.

- Word a text once for the whole site, in the locale's file: `ui: { sidePanel: { closeLabel: 'Fermer' }, pagination: { previousLabel: 'Précédent', nextLabel: 'Suivant' } }`. Every instance of the component reads it, an island's included.
- The key is the component's name in camel case, then the prop that sets the text: `SidePanel`'s `closeLabel` is `ui.sidePanel.closeLabel`. A prop given to the component replaces the message and the English both.
- A message may hold the placeholders its English shows, `{n}` or `{count}`, and a count may be written as plural forms: `rowCount: { one: '{count} ligne', other: '{count} lignes' }`.
- `kay check` leaves `ui.*` keys out of its comparison between locales, so a French block needs no English twin; a key a locale lacks reads the English.
- CommandPalette's `recentLabel` names the heading the recently followed links sit under.
- ContributionGraph's month names and the day and month a LineChart draws on its axis follow the page's locale; `en` keeps `5 Jan`.
- Rating's `{value}` and `{max}` and RangeInput's `{label}` fill the messages of the same name.
- ContactForm's labels read `ui.contactForm.*`, then kayjs-mail's `mail.contact.form.*` messages (English and French) before the English, and MarkdownEditor's `Uploading name…` marker, a placeholder in the text until the upload ends, stays English.
- Texts the app's data owns, a `failure`, a `message` or a `label` it passes, are the app's to word.

## The keys

- `ui.barList.*`: `emptyLabel` (`No data yet.`)
- `ui.carousel.*`: `dotLabel` (`Go to slide {n}`), `label` (`Carousel`), `nextLabel` (`Next slide`), `pauseLabel` (`Pause`), `playLabel` (`Play`), `previousLabel` (`Previous slide`), `slideLabel` (`Slide {n} of {count}`)
- `ui.commandPalette.*`: `emptyLabel` (`No results`), `label` (`Search`), `placeholder` (`Search`), `recentLabel` (`Recent`), `resultsLabel` (`{count} results, `1 result` for one`), `siteSearchError` (`The pages could not be searched`), `siteSearchLabel` (`In the pages`), `siteSearchMore` (`{count} more matches`, `1 more match` for one)
- `ui.confirmDelete.*`: `cancelLabel` (`Cancel`), `confirmLabel` (`Confirm`), `deleteLabel` (`Delete`), `pendingLabel` (`Deleting…`), `title` (`Confirm Deletion`)
- `ui.contactForm.*`: `emailLabel` (`Email`), `messageLabel` (`Message`), `nameLabel` (`Name`), `sentLabel` (`Thank you, your message has been sent.`), `submitLabel` (`Send`)
- `ui.contributionGraph.*`: `label` (`Contributions`)
- `ui.copyButton.*`: `copiedLabel` (`Copied!`), `failure` (`Could not copy to the clipboard`)
- `ui.dnd.*`: `handleItemLabel` (`Reorder {item}`), `handleLabel` (`Reorder`), `moved` (`Moved to {position} of {count}`)
- `ui.formDialog.*`: `cancelLabel` (`Cancel`), `savingLabel` (`Saving…`)
- `ui.iconPicker.*`: `clearLabel` (`Clear icon selection`), `emptyLabel` (`No icons found.`), `errorLabel` (`The icons could not be loaded.`), `gridLabel` (`Icons`), `moreLabel` (`Show more`), `placeholder` (`Search icons…`), `searchLabel` (`Search icons`), `searchingLabel` (`Searching…`)
- `ui.imageCropper.*`: `cropLabel` (`Crop area: arrows move it, Shift and the arrows resize it`), `cropText` (`{w} by {h} pixels at {x}, {y}`)
- `ui.lineChart.*`: `rangeHint` (`Shift with the arrow keys picks a span, Enter applies it, Escape drops it`)
- `ui.loadMore.*`: `failureLabel` (`Could not load more.`), `loadingLabel` (`Loading more…`), `retryLabel` (`Try again`)
- `ui.markdownEditor.*`: `keysHint` (`Tab indents a list item; Escape then Tab leaves the field.`), `placeholder` (`Write markdown…`), `uploadFailure` (`Could not upload the image`)
- `ui.mediaGallery.*`: `closeLabel` (`Close`), `emptyLabel` (`No media.`), `itemLabel` (`Media {n}`), `nextLabel` (`Next`), `openLabel` (`Open full size`), `previousLabel` (`Previous`)
- `ui.multiSelect.*`: `allLabel` (`All`), `emptyLabel` (`No match`), `noneLabel` (`None`), `placeholder` (`Any`), `searchLabel` (`Search`), `selectedLabel` (`{count} selected`)
- `ui.pagination.*`: `label` (`Pagination`), `nextLabel` (`Next`), `previousLabel` (`Previous`)
- `ui.rangeInput.*`: `fromLabel` (`{label} from`), `toLabel` (`{label} to`)
- `ui.rating.*`: `label` (`{value} out of {max}`)
- `ui.saveForm.*`: `cleanLabel` (`No unsaved change.`), `dirtyLabel` (`Unsaved changes.`), `discardLabel` (`Discard`), `saveLabel` (`Save`), `savingLabel` (`Saving…`)
- `ui.scatterChart.*`: `emptyLabel` (`No data yet.`)
- `ui.select.*`: `loadingLabel` (`Loading…`)
- `ui.sidePanel.*`: `closeLabel` (`Close`)
- `ui.siteNav.*`: `menuLabel` (`Menu`)
- `ui.splitLayout.*`: `backLabel` (`Back`), `resizeLabel` (`Resize list`)
- `ui.table.*`: `filterLabel` (`Filter`), `rowCount` (`{count} rows, `1 row` for one`), `selectAllLabel` (`Select all`), `selectRowLabel` (`Select {row}`), `selectedLabel` (`{count} selected`)
- `ui.toaster.*`: `dismissLabel` (`Dismiss notification`)
- `ui.zoomPane.*`: `fitLabel` (`Fit`), `zoomInLabel` (`Zoom in`), `zoomOutLabel` (`Zoom out`)
