# SEO lints

- The `seo` group reads what search engines and social networks see of a public site: one with `site` or `seo` set, or exported with `kay build --static`.
- On any other site they are allowed unless `lints` sets them or `seo`.
- No `// kay-allow` comment reaches them, as no template reports them.

- `kay check` reads kay.config.ts: `missing-site`, `missing-description`, `missing-share-image`, `default-favicon`.
- They point at kay.config.ts.
- `missing-share-image` and `default-favicon` name what a site lacks until it goes public, as a fresh project from `kay new` does, so only `kay build` and `kay check --only seo` report them, never a plain `kay check`.
- `missing-site` is reported by `kay build --static` alone: a server may read `SITE_URL` when it boots, and one with `seo` set and no site warns then.
- `kay check` reads the head blocks of the pages that say `prerender` (every page without params under `--static`) and their layouts, without rendering them, and reports `untitled-page`, `undescribed-page`, `duplicate-title`, `long-title`, `duplicate-description`, `long-description`, `unsized-share-image` and `noindex-in-sitemap` at the page's file; a tag whose value is an expression, or sits under an `if` or `for`, counts as given and is judged by its presence alone, so `kay check` is approximate: `kay build`, which reads the rendered HTML, may report a lint it does not, such as an `untitled-page` behind a branch that renders no title, or a `duplicate-title` between titles written as expressions.
- `kay check` reads the `redirects` of kay.config.ts for `redirect-chain`, which needs nothing else.
- `kay build` alone reads the pages against one another, from the HTML it rendered: `orphan-page`, `broken-canonical`, `one-way-hreflang` and `redirect-chain` through a redirect it rendered.
- What a build did not render is not read: a page rendered per request, its canonical or alternates pointing at one, another site's pages, so a site with such pages gets fewer reports and none is wrong for them; `orphan-page` is left out altogether while a page of the app without a guard renders per request (not one a library mounts), in a server build while a page has params (its `prerender` may list some values only), and for a site with no `site`; a `noindex` page is left out of `long-title` and `duplicate-description` too.
- Links are read as rendered, with `base`, `trailingSlash` and the host of a locale served by domain taken off.
- They point at the page's module and name the path; a page rendered per request is not read.
- One at `deny` fails the build and leaves the last one in place, as a failing check does; `--no-check` reads none.
