---
title: Migrating from Astro
order: 1
description: Translate an Astro site into a kay project with kay migrate astro, then finish by hand what it lists.
---

## Run the migration

`kay migrate astro` reads an Astro project and writes its `.astro` files as `.kay` ones.

Point `--outdir` at a new or empty directory, one with no `package.json`, and it writes a whole kay project there. With Bun pointed at kay's registry, as in [Installation](/getting-started/installation), run it from the Astro project.

```sh
bunx -p @kaynooo/kayjs kay migrate astro . --outdir ../my-site-kay
cd ../my-site-kay && bun install && bun run dev
```

The new project has these.

- `src/routes` with each page of `src/pages`, `404.astro` becoming `_404.kay` and `500.astro` `_error.kay`.
- Components and layouts in their own folders, named in kebab-case (`BaseLayout.astro` becomes `base-layout.kay`), with every import of them rewritten, through `tsconfig.json` aliases such as `~/*` too.
- `src/content.config.ts` rewritten for kay, its zod schemas written in `s`.
- The project's other files under `src` and `public` (stylesheets, modules, images, Markdown content, the favicon) copied as they are, those beside the pages moving with them into `src/routes`.
- A `package.json` with kay's scripts, and the Astro project's own packages minus Astro's.
- A `kay.config.ts` with the `site`, `base` and `<html lang>` the Astro site set.
- A `tsconfig.json` keeping the Astro project's `paths`.
- `src/server.ts` when the Astro site renders on demand (`output: 'server'` or an adapter); otherwise it is a static site built with `kay build --static`.
- Tailwind, ESLint, the Forgejo workflow and the Dockerfile when the Astro project had them.
- A `.gitignore` holding the Astro project's own entries too, a `fonts` entry in `kay.config.ts` for each Fontsource package the layouts imported, and none of the Astro project's ESLint or UnoCSS packages.

It never writes over a file that exists.

Run without `--outdir`, it writes the `.kay` files next to the `.astro` ones and leaves the Astro project's `package.json` alone. The project's files are then yours to add by hand.

## What it translates

| Astro | kay |
| --- | --- |
| The frontmatter | The fence, `--- server` on a page |
| `Astro.props` | `props<Props>()` |
| `Astro.url`, `Astro.params`, `Astro.cookies`, `Astro.redirect` in a page | The same on `ctx` |
| `class="a b"` | The `.a.b` shorthand |
| `class:list` | `class`, which takes the same arrays and objects |
| `{cond && ...}` and ternaries | `if` and `else` |
| `{items.map(...)}` | `for` |
| `<slot />` and named slots | `slot`, and `@name` blocks in the parent |
| `client:idle`, `client:visible` | `hydrate` |
| `set:html` | `innerHTML` through `trustHtml` |
| A layout's `<head>` | A `head` block |
| `<Icon name="mdi:sun" />` from astro-icon | The icon imported from `~icons/mdi/sun`, drawn as a tag (see [Images](/essentials/styling-and-assets)) |
| `import '@fontsource/inter/400.css'` | A `fonts` entry in `kay.config.ts` |
| `import text from './x.svg?raw'` | `import text from './x.svg' with { type: 'text' }` |

A page reads like this before.

```astro
---
import Layout from '../layouts/Layout.astro'
import Card from '../components/Card.astro'

const posts = ['First', 'Second']
const featured = Astro.url.searchParams.has('featured')
---
<Layout title="Blog">
  <h1 class="title">Blog</h1>
  {featured && <p class:list={['note', { strong: featured }]}>Featured only</p>}
  <ul>
    {posts.map(post => <li><Card title={post} /></li>)}
  </ul>
</Layout>
```

And after.

```kay
--- server
import Layout from '../layouts/layout.kay'
import Card from '../components/card.kay'

const posts = ['First', 'Second']
const featured = ctx.url.searchParams.has('featured')
---
Layout(title="Blog")
  h1.title Blog
  if featured
    p(class={['note', { strong: featured }]}) Featured only
  ul
    for post of posts
      li
        Card(title={post})
```

## Finish by hand

Kay's `tsconfig.json` turns on `noUncheckedIndexedAccess`, so `cells[index]` is typed `Cell | undefined`, and plain modules written without it report errors in files no `.kay` touches. Add `"noUncheckedIndexedAccess": false` to the app's own `compilerOptions` to keep them as they are, or write the `!` where the index is known to exist.

The command ends with a list of what it could not translate, each item at its line in the Astro file.

In the `.kay` file, the code an item concerns is commented out under a `// kay migrate:` line. A search for `kay migrate:` finds every place left. Each kind has its kay counterpart.

- **A script Astro bundles** (`<script>` with no `is:inline`): write what it does as an [island](/essentials/islands), or import it in an inline script.
- **An endpoint** (`src/pages/*.ts`): an [API route](/guides/api-routes) in `src/api/`, or an [endpoint file](/essentials/routing#endpoint-files) for a feed or a `robots.txt`.
- **`await` or `Astro.url` in a component**: a component renders synchronously, so load the data in the page's server fence and pass it down as a prop (see [Data loading](/essentials/data-loading)).
- **`getStaticPaths`**: list the params in `export const page = { prerender: [...] }`.
- **A Svelte, React or Vue component**: rewrite it as a `.kay` island.
- **`astro:assets` and `Image`**: an imported image is its URL, `img(src={photo})`, which kay sizes and serves in modern formats (see [Styling and assets](/essentials/styling-and-assets)).
- **Tailwind 3**: kay builds with Tailwind 4, so upgrade the stylesheets with `bunx @tailwindcss/upgrade`.
- **Attributes on `<body>`**: kay writes `body` itself, so move them to an element inside it.
- **`Astro.self`**: a component rendering itself imports its own `.kay` file under a name and renders that.
- **`import.meta.env`**: declare the variable in a `defineEnv` schema from `kay/server` and read it from there, or in `publicEnv` for an island (see [Data loading](/essentials/data-loading)).
- **A script from another host**: kay's Content-Security-Policy blocks it until `security: { csp: { 'script-src': ['https://unpkg.com'] } }` in `kay.config.ts` allows it.
- **UnoCSS**: kay has no plugin for it, so its packages are left out and a class only UnoCSS knows (a variant group, a shortcut, a custom variant, a theme colour) passes through unstyled; port them to Tailwind 4.
- **A `@kaynooo/*` range** carried over: the registry may hold no version in it, which fails `bun install`.
- **A Markdown page** (`src/pages/*.md`): make it an entry of a [content collection](/guides/content) and render it from a page.
- **A `site` or `base` that is not a plain string**, such as one read from the environment: set it in `kay.config.ts`.

Then run `bun run check`. It type-checks every `.kay` file and reports what is still wrong at its line.

The migrated `kay.config.ts` leaves out kay's `seo` defaults, since the pages write their own head. So a page with no description is reported too. Give it a `meta(name="description")` in its `head` block, or set `seo.description` for every page.

<ReadMore href="/llms/project">The command's full behaviour, with every option of the other `kay` commands, is in the project reference.</ReadMore>
