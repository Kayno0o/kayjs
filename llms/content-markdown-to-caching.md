# Content collections: Markdown to caching

## Common tasks

- Define a collection, list its entries or render one as a page: the tasks of [Content collections](content.md#common-tasks).

## Reference

### Markdown files

- A Markdown file starts with YAML frontmatter between `---` lines.
- Every entry's data is read against the schema: defaults filled in, an `s.Date()` decoded from its text.
- An entry it refuses, or one that does not parse, fails `kay check` at the field's line, naming the field's whole path (`packs.0.price`), and fails `kay build` and the first load; a loader's refused entry is instead left out and logged ([Loaded collections](content-cms.md#loaded-collections)).
- Defaults fill nested objects and list items too, and `migrations: [renameField(...), convertField(...), setField(...)]` on the collection carries entries over after a schema change ([Loaded collections](content-cms.md#loaded-collections)).
- Headings get ids, deduplicated, and link to themselves.
- Bare URLs become links.
- A link leaving the site gets `target="_blank" rel="noopener"` as each page renders against its `site`, and `renderMarkdown` writes it too, unless the tag writes its own `target` ([Navigation](navigation.md#navigation)).
- `markdown: { highlight, headingLinks, readingSpeed, imageSizes }` in `kay.config.ts` sets these once for every collection; a collection's option of the same name wins. `headingLinks: false` leaves a heading's text plain, its id kept, and `readingSpeed` is the words a minute `readingTime` counts at, 230 by default.
- A relative image of an entry's body, `![A cat](./cat.png)` or `<img src="../cat.png">`, that sits inside the collection's folder and is a PNG, JPEG, WebP, GIF or AVIF is built as an asset and rendered as `image()` renders an imported one: a `srcset` of WebP and AVIF variants over `images.widths`, `sizes` of `100vw`, `width` and `height`, and lazy loading. `markdown: { imageSizes }` in `kay.config.ts`, or `imageSizes` on a collection, sets the `sizes` of all of them, such as `(min-width: 60rem) 40rem, 100vw`, and a `sizes="..."` on a tag sets its own and keeps the rest. An image the tag sizes itself (`width`, `height` or `srcset`), an animated GIF, an SVG, a URL, an absolute path, a missing file or one outside the folder (a `..` out of it, a symlink) is left as written.
- `highlight: (code, language) => html` highlights code blocks as entries compile, at build time: it returns the whole `<pre>`, such as Shiki's `codeToHtml`, which the site depends on itself. kayjs-ai's chat also calls the `markdown.highlight` of `kay.config.ts` on the server, at runtime, for the code of its answers, so it must work then too.
- Without a highlighter, a block renders as `<pre><code class="language-ts">`.

### Components in Markdown

- A Markdown entry uses the components its collection's `components` names, written with a capital as in a template: `<Callout type="warn">` on its own line, Markdown inside after a blank line, then `</Callout>` on its own line; `<Badge text="new" />` inline.
- Attributes are text (`type="warn"`), JSON in braces (`count={3}`, `items={["a", "b"]}`), or bare for `true`, and may spread over several lines.
- Their text never becomes markup: an `innerHTML` attribute, or JSON holding an object with a string `t` (how kay marks markup), fails the build.
- An interactive component renders as an island and hydrates as in any page.
- A page rendering an entry's `Content` links the stylesheets those components import, for every collection its `--- server` fence imports.
- A tag in a code span, a fenced code block or an indented one stays text.
- Attributes take JSON of any depth; quoted text may hold `>` or `}`.
- A component the collection does not name, a tag left open, or a capitalized tag kay cannot read (stray text after a JSON value, a quote or brace never closed) fails `kay check`, the build and `bodyHtml` at its line (`markdown-invalid`), rather than reaching the page as text; so does a closing tag holding more than its name.
- In prose, `<` before a capital reads as a tag once it sets an attribute value or a `>` follows it in the paragraph, code spans and blockquote `>` markers left out and a blank line ending the paragraph, so `if 1<A then` and `<Chart stray` at the end of a body stay text, escaped: write `&lt;` for a literal one. Attribute text holds no backtick, which opens code.

### Pages from a collection

- `export const page = { prerender: posts }` in a page with one param prerenders a page per entry, its slug as the param; `sitemap` takes a collection the same way. That page's head takes the entry's `title`, `description` and date unless the page sets them ([Head](head.md)).
- A slug with a slash needs a catch-all page, `[...slug].kay`.

### Pagination

- `isCollection` and `isPaginated` from `kay/content`, and the symbol marking a collection, are how kay recognizes a collection or a paginated result in a module's exports: kay's own, not API for an app.
- `paginate(posts, 10)` from `kay/content` splits a collection, an array, or a function returning one into pages, for a page whose one param is optional, `blog/[[page=integer]].kay`: `const blog = paginate(posts, 10)`, `export const page = { prerender: blog }`, then `const list = await blog.page(ctx.params.page) ?? ctx.notFound()`; `blog.pageSize` is the 10 (`size` is its old name, kept three minors).
- `list` has `items`, `page` and `pages`, from 1, `prev` and `next`, links undefined at the ends, and `href(n)`.
- Page 1 is the list's own path, `/blog`, and `page()` gives `undefined` for `/blog/1`, a page past the last, or anything but a whole number from 1.
- Its links are in the request's locale, under `base`, with a trailing slash under `trailingSlash: 'always'`.
- As the `prerender` or `sitemap` key of `page` it lists every page; a localized collection counts each locale's entries, the default locale's standing in for those it lacks, so a locale with more entries has more pages, listed in it alone.
- kayjs-ui's `Pagination(of={list})` draws its links.

### Rendering Markdown

- `renderMarkdown(text, { highlight })` from `kay/content` renders Markdown the app has at runtime, such as a user's note or a feed, as entries render, headings anchored and code highlighted when given a highlighter, and gives `{ html, headings }`.
- The HTML is the writer's, raw tags included, so a user's goes through `sanitizeHtml` before `innerHTML`, and a user may add headings by typing their tags.
- The highlighter gets a fence's language as the user typed it, so it falls back for one it does not know rather than throw.
- `bodyHtml(body)` from `kay/content` gives the HTML an entry's body puts on the page, each component standing as a `<kay-component>` element around what it wraps, for a CMS to check what an editor wrote before saving it, and throws `MarkdownError` from `kay/content` (its `line` set) for components kay cannot read.
- `highlightCode(code, 'ts', { highlight })` from `kay/content` renders one code block the same way, `<pre><code class="language-ts">` without a highlighter, as a `SafeHtml`: `const snippet = await highlightCode(source, 'ts', { highlight })` in a server fence, then `div(innerHTML={snippet})`.
- Both run on the server.
- `markdownHtml(text)` from `kay/markdown` renders Markdown a user writes as it comes, in an island too, such as a chat reply streaming in or an editor's preview: `div(innerHTML={markdownHtml(text())})`.
- It is `renderMarkdown`'s HTML put through `sanitizeHtml`, keeping tables, their `align`, images (`src`, `alt`, `title`) and the disabled checkboxes of task lists as well, with plain headings, no id or anchor, and no code classes, so it is a `SafeHtml`; it is sync and fast enough to run again on every chunk.
- On the server it is Bun.markdown; in an island marked, with a renderer writing the same HTML, which only the islands importing it load, about 15 KB gzipped, plus `sanitizeHtml` in the runtime every page with an island loads, 1.3 KB, unless something already uses it.
- The two differ only where Bun.markdown is odd: a named reference such as `&copy;` stays written in the island, which the browser shows the same; a URL with parentheses or a `"` in its path, and one still being typed, without a dot yet or ending in `=`, is a link in the island alone; a task item whose text the next line underlines as a heading is not a task in the island.
- The island keeps marked linear: an emphasis or a strikethrough closes within 1,000 characters there, and text past 100,000 characters, or nested too deep for marked, shows as it is written.

### Feeds

- `feed` serves an RSS 2.0 feed at its path, `format: 'atom'` for Atom, its `author` the feed's title unless set: the newest `limit` items, 20 by default, that `item` returns, links and guids absolute on the `site` kay.config.ts sets, which a feed needs, written as `trailingSlash` writes each page's canonical URL.
- A link to its path, such as `link(rel="alternate" href="/blog/rss.xml")` in a layout, passes `kay check` when the path is written as a literal.

### Localized collections

- `localized: true` keeps each entry in a folder named after its locale, `fr/hello.md` and `en/hello.md` being translations of one entry, slug `hello`, with `i18n` in kay.config.ts (see locales).
- `all()` and `get(slug)` read the request's locale, the default locale's entry standing in for one the locale lacks or keeps as a draft; `entry.locale` names the folder it came from and `entry.translations` the locales holding the slug.
- `translation(entry, locale)` gives the entry of that locale paired with `entry` by slug or `translationKey`, whatever its own slug, or undefined, with no fallback: a language switcher links `entry.translations` through it.
- Either takes a locale as last argument; outside a request `all()` gives every locale's entries and `get(slug, locale)` reads that locale's alone, with no fallback.
- A page prerendering or listing the collection in its sitemap gets each slug once, in every locale.
- A feed carries an ETag and answers 304 to a reader holding it, for an hour in production.
- The feed is served once per locale, `/en/blog/rss.xml`, listing only the entries written in it, its links in that locale; with domains each host serves its own at the path.
- `kay i18n translate <locale>` (kayjs-ai) creates the entries a locale lacks as drafts: the collection's `draft: '<field>'` field set to `true`, or a `# draft` first line in the entry's YAML when it has none.
- An entry outside a locale folder fails `kay check` and the build.

### Caching

- `posts.invalidate()` loads the entries afresh on the next read; it also marks the prerendered pages that read the collection stale (`kay build` keeps a page over a folder collection by itself, not one over a loader: add `prerender: true` for that), in every process sharing a `sqliteCache`; for a folder it matters in development, where the files change.
- Each entry compiles once and is cached in `.kay/cache/content`, one file per entry holding the content's hash, the highlighter's source, the source of every project module the content config imports (a highlighter's helpers) and Bun's version it was compiled with, so a change to an entry recompiles that entry only, and a change to a module the config imports recompiles them all when the collection has a highlighter.
- A highlighter whose output changes with no change to its source, such as a new theme passed in, a `.kay` file or a data file (JSON, YAML) it reads, needs that folder cleared: only `.ts` and `.js` modules the config imports are hashed.
- `kay build` compiles every collection into `.kay/client/content`, which production reads, an executable included, instead of the files.
