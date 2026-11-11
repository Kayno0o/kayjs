# kayjs-ui: blocks, links and parts of the components

## Common tasks

### Put markup where a component takes a string

- A title or description that is only drawn takes a block under the same name: `Card`, `PageHeader`, `PageSection`, `Widget` and `EmptyState` take `title` as a string or a `@title` block, `PageHeader` and `EmptyState` `description` as a string or a `@description` block. The block is drawn inside the heading element, so its level and part stay: `Card(level={2})` then `@title` and `a(href="/moons") Moons`. A block and the string of the same name cannot both be passed.
- A string that is also the accessible name stays a string and gets a block beside it. `Dialog`, `SidePanel`, `FormDialog` and `ConfirmDelete` take `title: string | Snippet` as Card does: a `@title` block is drawn inside the title element in place of the string, for an icon, a badge or an emphasised name, and names the dialog through that heading unless `label` gives a name of its own (`label` on Dialog, SidePanel and FormDialog, `Dialog(label="Rename planet")` with `@title` full of markup). `@heading` and `heading` are the deprecated forms of `@title`, which `deprecated-ui-props` rewrites with `label` for the old string. `ConfirmDelete` keeps `message` and takes `@details`, drawn under it in the dialog (the inline pair has no room for it, and is named by `message`).
- An entry of a list takes a block named after the entry, called with it, that replaces the entry's text: `@tab(tab)` on `Tabs` and `TabNav`, `@item(item)` on `Breadcrumb`, `@link(link)` on `SiteNav` and `AppHeader` (children included), `@slide(slide, index)` on `Carousel` (the whole slide's content), `@caption(item, index)` on `MediaGallery` (the stage and lightbox caption). The `icon` and `badge` the entry's data names are still drawn around the text, and its `label` stays what it is called in data.
- One item shape: every list of the library takes items of `{ key, label, description?, href?, icon?, tone?, disabled? }` (a Menu entry, a Timeline entry, an Accordion item, an AppSwitcher app, an AudioPlayer chapter, a MediaGallery item, a Step, a NavLink, a TreeNode's `label`, `href` and `icon`), each with only what it uses. `key` tells the items apart; `value` appears only where it is what a form submits (a Select, Combobox, MultiSelect or RadioGroup option, a Tabs `value` that `value` and `onChange` carry). Before 1.99 a Timeline entry's `label` was `text`, an Accordion item's `key` and `label` were `value` and `title`, a MediaGallery item's `label` was `title`, an AppSwitcher app's `key` was `id`, and an AudioChapter's `label` and `href` were `title` and `url`: the old names still work until 1.103 and `kay check` rewrites them (`deprecated-ui-items`). `MenuAction` takes `tone: 'danger'`, as the other items take a `tone`.
- A block taking values makes a static component an island, as any block with parameters does: `TabNav`, `Breadcrumb` and `SiteNav` ship script on the page that uses one, and write `--- island` in place of `---` where the page says so.

### Make a component a link

- `href` on `Avatar`, `Badge`, `Card`, `CardRow` and a `Timeline` entry (`entries[].href`) renders an `a` with the same parts, so middle-click and a new tab work. An `Avatar` link is named by `label`, else by `name`.
- `Card(href)` needs a `title`, which is the link's text, and `CardRow(href)` links its body. The link covers the whole card or row, and every button, input and link inside it, `actions` included, is lifted above the link and stays clickable; the card or row has `data-linked`.
- A `Timeline` entry with an `href` is no button: `onSelectedChange` is not called, and the entry whose key is `selected` gets `aria-current="true"` in place of `aria-pressed`.
- A `Carousel` slide with `href` draws its picture inside a link; with a `@slide` block the block draws the whole content, link included.
- Every entry with an address takes `newTab: true | false | 'auto'`, `'auto'` by default: an `https://` or `//host` address opens in a new tab with `rel="noopener noreferrer"`, a path stays in the same one. It is on `MenuAction`, `BellItem`, `AudioChapter`, `PaletteLink` (its `external: true` is `newTab: true`), `NavLink` (`SiteNav`, `AppHeader`), `Breadcrumb` items, `TabNav` links, `Timeline` entries, `TreeView` nodes, `BarList` rows and `Carousel` slides; `AppSwitcher` keeps `false` as its default (switcher and app both take `'auto'`). `isExternal(href)` is the test they share, exported by kayjs-ui: any absolute http(s) or protocol-relative address counts as outside, the site's own origin included, as the server and the browser must agree; write `newTab: false` on such a link to keep it in the tab. The `href(mark)` charts (`BarChart`, `Sparkline`, `ScatterChart`, `ContributionGraph`, `LineChart`) take one `newTab` for all their links.
- `LineChart(href={mark => ...})` makes a point a link, like the other charts: a click without a drag or Enter on it follows the address (a new tab when it leaves the site), unless `onSelect` is given, which hears it instead. The plot is one element, so there is no middle click or "copy link", and the address is read out with the point.

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

- Empty, loading and failure states: every component showing data takes `emptyLabel` for what it reads with nothing to show (a default wording, `ui.<component>.empty`) and an `@empty` block that replaces it with the app's markup, such as an `EmptyState`; the BarChart, BarList, ScatterChart, LineChart, ContributionGraph, Sparkline, StatusStrip, Timeline, DescriptionList, TreeView, MediaGallery, Carousel, VirtualList, Table, Combobox, MultiSelect, IconPicker and CommandPalette do. One that loads takes `loadingLabel`, `failureLabel` and `retryLabel`. `EmptyState` takes an `icon` above its title and a `tone` (`danger` for a failed list) colouring both.
- Heading levels: every titled component takes `level` (1 to 6) and its default is the heading it usually is under the page's `h1`. `PageHeader` `1`; `PageSection`, `Widget` and `Dialog` (2 to 6) `2`; `Card` `3`; `EmptyState` none (a paragraph until `level` makes it a heading); `CollapsibleSection` and `Accordion` none (a span in the summary until `level` makes the title a heading). Pass the level under the heading above when a component sits deeper.
- New parts: `Tabs` and `TabNav` `badge` (and `TabNav` `icon`), `Breadcrumb` `icon`, `SiteNav` `expand`, `expandIcon` and `children`, `Card` and `CardRow` `link`, `Carousel` `link`, `ConfirmDelete` `details`, `Notice` `icon`, `body`, `actions` and `dismiss`.
- `SiteNav` link blocks apply to the links of `children` too; the `ui.siteNav.expand` text is `Show the pages under {label}`, and `ui.notice.dismiss` is `Dismiss`.
- `Dialog`, `SidePanel` and `ConfirmDelete` keep their strings as the names screen readers hear; a block never replaces the `aria-label`.
- The same names serve every component of a kind, so a component added later takes the block named after its entry the same way.

### One name for one role

- The same role has the same block name in every component: `@actions` the controls a component holds beside its own content (a Card, Widget, PageHeader, PageSection, EmptyState, Notice, FormField, AppHeader, SidePanel, Dialog's head line, TreeView's and AudioPlayer's rows, a MarkdownEditor's toolbar, a Chat turn), `@footer` the area under the content, `@empty` what a data component shows with nothing to list, `@item(entry)` and its kin (`@tab`, `@link`, `@slide`) the markup of one entry of a list, and `@trigger` the control opening a Popover, Menu, BellInbox or AppSwitcher.
- A `Table`'s `@bulk(keys, clear)`, a `CardRow`'s `@right` readout and a `FormDialog`'s `@extra` stay as they are: they are shown on a condition (rows picked), always, and in the footer, not beside the content.
- A prop that picks a look rather than content is not named like a block: ConfirmDelete's `triggerLook` is `icon`, `button`, `link` or `none`.
