---
title: Performance and the dev tool
order: 9.3
description: Find what a page costs and what went wrong in it, with the dev tool and inspector under kay dev, and the size report, --analyze and budgets in kay build.
---

Under `kay dev`, every page carries a small bar, at the bottom left by default, with a count of the page's problems. Click it, or press Alt+Shift+K, to open the dev tool. Press Escape to close it.

Drag the drawer by its head to move it, and by an edge or a corner to resize it. With the keyboard, focus its bottom right corner and use the arrow keys. Three buttons in its head let it float or dock it to the bottom or the right of the window. Docked, it pads the page so nothing hides under it. Drag the bar to move it to another corner. A new tab places the tool where you left it. On a window 480 pixels wide or less, the drawer spans the window instead.

```sh
kay dev --open
```

The bar shows kay's mark and the count of problems, red when one is an error and amber for a warning. Production pages never carry the dev tool.

The drawer follows your system's light or dark theme. Each tab has an icon and a count, red for errors, amber for warnings and plain otherwise. The counts are there as the page loads and follow each page swap, so you need not open a tab to see its warnings. When the drawer is narrow the tab list shrinks to the icons.

The Problems tab has a Copy button. It puts every listed problem on the clipboard as plain text, starting with the page URL, so you can paste them into an LLM. Problems you dismissed are left out.

The copy button in the drawer's head copies the open tab as Markdown, as it is shown. Request, Head, Routes, Env and Images have a filter box, and Head and Images a "Problems only" toggle, so you can narrow a tab before copying it. Addresses, header values and env values have their own copy button.

A file a tab names is a button: click it to open the file in your editor, at the line when the tab gives one.

## The tabs

Each tab answers one question about the page in view. A tab with a red or amber count needs your attention: Request counts a page answered with an error status, Performance a Web Vital past its good limit.

| Tab | Shows |
| --- | --- |
| Problems | Errors, recovered mismatches, blocked sources, accessibility findings and `kay check` results |
| Request | The route, layouts, params, locale, guards, redirects, response headers and the time the server spent on guards, imports, loads and render |
| Network | What the page fetched since its load and over the last page swaps, with each request's kind, status, size and time |
| Head | The search result, canonical and hreflang links, social tags and JSON-LD |
| Screen reader | The page's landmarks, headings, links, controls and form fields in reading order, with the names a screen reader speaks |
| Routes | Every page, endpoint and API route the server serves |
| Env | The variables `publicEnv` sends to the browser |
| Images | Each image's variant, format, size and what it is drawn at |
| Performance | The Web Vitals of the load and the weight of the page |
| i18n | The page's locale, its copies and the message keys no locale has |
| Islands | Each island, its props size, how long it took to hydrate and the values its signals hold now |

A library can add a tab of its own, with nothing to declare in the app. kayjs-auth shows who is signed in, kayjs-mail lists the mails sent to the outbox, and kayjs-cms toggles edit mode.

<ReadMore href="/llms/component-libraries#a-tab-for-a-library">Writing a tab for your own library.</ReadMore>

## Problems

The Problems tab collects what went wrong on the page. It lists errors nothing caught, islands that did not match their server markup, sources the Content-Security-Policy blocked, and what axe-core finds in the rendered page.

It also shows what `kay check` reports without type checking. A problem logged again shows once, with how many times it came.

Click a problem to open its `.kay` file in your editor. Dismiss hides a problem for the rest of the browser tab, until its text changes.

## The tab order

The list icon in the drawer's head turns on the tab order. Each element the keyboard reaches gets a numbered badge, in the order Tab walks them, with a line from one to the next. The overlay stays on when the drawer is closed, and follows scrolling, page swaps and changes to the page. It numbers the elements inside open shadow roots too, but cannot see into closed ones.

A line that moves up the page is dashed red and its badge ends in "!". It comes from a positive `tabindex` or from a visual order unlike the document's.

A badge in amber means that element shows nothing when it has focus, no outline or ring. To check that, the tool moves focus through the elements and puts it back, so an `onfocus` handler on your page runs. It checks again when a class or style changes, and only checks elements the browser would draw a focus ring on, so a button you clicked with the mouse may be skipped until you use the keyboard.

Nothing is checked while focus is inside a closed shadow root, as the tool could not give focus back. The page reports the host in that case, so the check also waits while focus is on a custom element or a block element such as a `div` with a `tabindex`, and runs at the next change to the page once focus has moved on.

A dashed red box marks a place the keyboard may get stuck: a part of the page marked `inert` while no dialog is open, or a modal that is not an open `dialog` element, which only a script can keep focus in. That second one is a hint, not proof, so press Tab and Escape inside it. Each finding also shows under Problems, with the elements it names outlined on hover.

## The screen reader view

The Screen reader tab lists what a screen reader stops at, in the order it reads: landmarks (`header`, `nav`, `main`, `footer` and elements with a landmark `role`), headings with their level, links, buttons and other controls, and form fields. Each row shows the role and the accessible name, a link's address, and a field's description and whether it is required.

A row is flagged when a person using a screen reader would be stuck: a heading level skipped, a page with no `main` landmark or with two, a link, control or field with no name, and links with the same name that go to different places, such as two "Read more". The tab's count is the number of flags.

Hover or focus a row to outline its element in the page, and click it to scroll there. The row names the `.kay` file that wrote the element, and a click on the file opens it in your editor. The list is read again after each page swap and each change to the page, an island's included.

The names follow the steps browsers use: `aria-labelledby`, `aria-label`, `label` elements, `alt`, the element's text and `title`. The tool works them out from the page itself, so a name can differ in small ways from the browser's own. Text a stylesheet adds with `::before` or `::after` is not read, and anything hidden with `display: none`, `visibility: hidden`, `hidden`, `inert` or `aria-hidden` is left out.

## Request and head

The Request tab shows what served the page: the route it matched, its layouts, params and locale, and how long each load took. It lists the guards that ran and what each did, and the redirects the request went through.

The Head tab shows the head as a search result: the title and description with their length, the canonical link, the social card preview and each JSON-LD block. What `kay check` would flag in the head of a built page shows as a problem.

## Images

The Images tab lists each image of the page. It shows the variant kay served, its format and size, and the size it is drawn at.

It flags an image served at more than four times the pixels it shows (an SVG is never flagged for this, as it draws at any size; it is found by a name ending in `.svg`, or by the type the server sent for it), one with no `width` and `height`, and a lazy-loaded one that is already in view. Copies of one image drawn at the same size share a row, with their count. Hover a row to outline the image on the page.

## Web Vitals

The Performance tab shows the Web Vitals of the page load as the browser reports them. LCP, CLS and INP each appear against their good limit, 2.5 s, 0.1 and 200 ms.

The weight of the page follows: the HTML, the CSS and the JS it loaded, gzipped, file by file. These are dev sizes, with nothing minified, so `kay build` makes them smaller.

Under them, "Last kay build" gives the scripts and stylesheets the last build measured for the page's route. A `~` marks an estimate.

## The inspector

Every page `kay dev` serves knows which `.kay` line wrote each element. Hold Alt to outline the element under the pointer with its file, line and column.

```text
h1 src/routes/index.kay:12:3
```

Alt+click opens that line in your editor, and the click never reaches the page. Inspect, on the dev tool's bar, does what Alt does until the next click or Escape. Use it where your system keeps Alt+click for itself.

The Islands tab lists each island's component. A click opens its file, and hovering a row outlines the island.

## Choose the editor

The editor is `KAY_EDITOR`, else `VISUAL` or `EDITOR` when they name a known editor, else the first one found on the `PATH`. kay knows VS Code, Cursor, Zed, Sublime Text, JetBrains IDEs and code-server.

`KAY_EDITOR` may be any command. It gets the position the way the editor among its words takes it, or the file appended.

```sh
KAY_EDITOR=zed bun run dev
KAY_EDITOR="tmux new-window nvim" bun run dev
```

With no editor found, the page says so and the terminal prints the position. Tests, `pages({ dev: true })` and production builds carry no inspector.

<ReadMore href="/llms/dev-server">Editors reached over SSH and how the position is passed to each editor.</ReadMore>

<ReadMore href="/llms/dev-tool">The other dev tool tabs in full.</ReadMore>

## The error page

When a page throws and the app has no `_error.kay`, kay shows an error page in development. It holds the message, the lines around where your code threw and your stack frames, with those of kay and the dependencies folded away.

A Copy button copies the message and stack as the terminal shows them. A compile error appears as `kay check` prints it. The page reloads itself once the error is fixed.

## What a page weighs

`kay build` prints the JavaScript a page with islands loads, gzipped and minified. It lists the entry first, then what each island adds, the heaviest first.

```sh
kay build
```

Three tables follow. Routes has one row per route, with the gzip scripts and stylesheets it loads. Stages shows how long each step took. Caches shows how many entries each cache gave and how many it had to make.

A route that no page of was prerendered has no built page to measure. Its scripts are an estimate, marked `~` in the table. kay adds the entry and every island its components can reach, through helpers, dynamic imports and aliases. A chunk several islands share counts once. The entry is added as well when a form posts to an action or a server island is deferred.

Each size shows its change since the last build, as `[+3.2 KB]`, or `[new]` for a row the last build did not have. The sizes are kept in `.kay/report.json`.

## Find the heavy modules

Add `--analyze` to name the five modules that weigh most in the entry and in each island. A package counts as one module, and kay's runtime is listed file by file.

```sh
kay build --analyze
```

Use it when an island is larger than you expect. The module at the top is usually a library you can load later or replace.

## Set a budget

A budget makes the build warn when a page loads too much. Nothing is limited until you set one.

```ts
export default defineConfig({ budget: { js: '20kb', css: '10kb' } })
```

Each key is a size in bytes, or a string ending in `b`, `kb` or `mb`. It limits what one page loads, compressed as a host serves it.

The build then warns with `over-budget` for each route over its budget. The warning names the file and the three modules that weigh most in its scripts.

Set the lint to `deny` to fail the build on it, or pass `--deny-warnings`. Each limit must be a positive size. `kay check` refuses zero, a negative number and an exponent.

```ts
export default defineConfig({
  budget: { js: '20kb' },
  lints: { 'over-budget': 'deny' },
})
```

<ReadMore href="/llms/build-and-start">How a route's scripts are estimated when none of its pages was prerendered, and the JSON form of the report.</ReadMore>
