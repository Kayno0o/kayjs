# kayjs-ui: blocks, links and parts of the components

## Common tasks

### Put markup where a component takes a string

- A title or description that is only drawn takes a block under the same name: `Card`, `PageHeader`, `PageSection`, `Widget` and `EmptyState` take `title` as a string or a `@title` block, `PageHeader` and `EmptyState` `description` as a string or a `@description` block. The block is drawn inside the heading element, so its level and part stay: `Card(level={2})` then `@title` and `a(href="/moons") Moons`. A block and the string of the same name cannot both be passed.
- A string that is also the accessible name stays a string and gets a block beside it. `Dialog`, `SidePanel` and `FormDialog` keep `title` (the `aria-label`) and take `@heading`, drawn inside the title element in place of its text, for an icon, a badge or an emphasised name. `ConfirmDelete` keeps `message` and takes `@details`, drawn under it in the dialog (the inline pair has no room for it, and is named by `message`).
- An entry of a list takes a block named after the entry, called with it, that replaces the entry's text: `@tab(tab)` on `Tabs` and `TabNav`, `@item(item)` on `Breadcrumb`, `@link(link)` on `SiteNav` and `AppHeader` (children included), `@slide(slide, index)` on `Carousel` (the whole slide's content), `@caption(item, index)` on `MediaGallery` (the stage and lightbox caption). The `icon` and `badge` the entry's data names are still drawn around the text, and its `label` stays what it is called in data.
- A block taking values makes a static component an island, as any block with parameters does: `TabNav`, `Breadcrumb` and `SiteNav` ship script on the page that uses one, and write `// kay-island` where the page says so.

### Make a component a link

- `href` on `Avatar`, `Badge`, `Card`, `CardRow` and a `Timeline` entry (`entries[].href`) renders an `a` with the same parts, so middle-click and a new tab work. An `Avatar` link is named by `label`, else by `name`.
- `Card(href)` needs a `title`, which is the link's text, and `CardRow(href)` links its body. The link covers the whole card or row, and every button, input and link inside it, `actions` and `head` included, is lifted above the link and stays clickable; the card or row has `data-linked`.
- A `Timeline` entry with an `href` is no button: `onSelectedChange` is not called, and the entry whose key is `selected` gets `aria-current="true"` in place of `aria-pressed`.
- A `Carousel` slide with `href` draws its picture inside a link; with a `@slide` block the block draws the whole content, link included.

### Icon, badge, disabled and nesting in navigation

- `Tabs` tabs, `TabNav` links and `TabNav` tabs share `{ label, icon, badge, disabled }`: `icon` before the label, `badge` (a count or short text, part `badge`) after it. A disabled `TabNav` link is a `span` with `aria-disabled="true"`, never current; a disabled `Tabs` tab is a disabled button the arrow keys skip.
- `Breadcrumb` items take `icon`; the structured data keeps the `label`.
- A `NavLink` of `SiteNav` and `AppHeader` takes `children`, one level of links. The link keeps its own page and is followed by a button (`expand`, named by `expandLabel`, `{label}` standing for the link's) that opens the children as a popover from `lg`; in the menu of a narrow screen they are always shown, nested under it.
- `SiteNav` and `AppHeader` take `open` and `onOpenChange(open)` for the menu of a narrow screen: the page sets it, for instance to close it on its own navigation, and is told whenever it shows or hides. An `onOpenChange` makes the nav an island.

### Dismiss, icon and actions on a Notice

- `Notice(dismissible)` adds a close button (`dismissLabel`) that hides the notice, and `onDismiss` hears it. `open` makes the page decide: `open={false}` starts it hidden, and a page setting it back to `true` shows it again. Without either the notice ships no script; an `onDismiss` makes the whole notice hydrate.
- `icon` draws one before the text: `true` is the icon of the tone, or give an icon of your own. `@actions` draws a retry button or a link at the end. A notice with none of them keeps its plain markup.

### Control and hear the lightbox of a MediaGallery

- `MediaGallery(open={shown()} onOpenChange={(open, index) => shown = open})` follows `open` and is called with the new state and the index on the stage whenever a visitor opens or closes the lightbox. A change the page made through `open` is not echoed.

## Reference

- Heading levels: every titled component takes `level` (1 to 6) and its default is the heading it usually is under the page's `h1`. `PageHeader` `1`; `PageSection`, `Widget` and `Dialog` (2 to 6) `2`; `Card` `3`; `EmptyState` none (a paragraph until `level` makes it a heading); `CollapsibleSection` and `Accordion` none (a span in the summary until `level` makes the title a heading). Pass the level under the heading above when a component sits deeper.
- New parts: `Tabs` and `TabNav` `badge` (and `TabNav` `icon`), `Breadcrumb` `icon`, `SiteNav` `expand`, `expandIcon` and `children`, `Card` and `CardRow` `link`, `Carousel` `link`, `ConfirmDelete` `details`, `Notice` `icon`, `body`, `actions` and `dismiss`.
- `SiteNav` link blocks apply to the links of `children` too; the `ui.siteNav.expand` text is `Show the pages under {label}`, and `ui.notice.dismiss` is `Dismiss`.
- `Dialog`, `SidePanel` and `ConfirmDelete` keep their strings as the names screen readers hear; a block never replaces the `aria-label`.
- The same names serve every component of a kind, so a component added later takes the block named after its entry the same way.
