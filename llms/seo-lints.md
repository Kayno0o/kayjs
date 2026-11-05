# SEO lints

## Common tasks

- Make a site public to read it: set `site` or `seo` in kay.config.ts, or export it with `kay build --static`; `kay check --only seo` lists the ones read without rendering, `kay build` all of them.

## Reference

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

### The lints

| Lint | Default | Group | Reports |
| --- | --- | --- | --- |
| `missing-site` | warn | seo | `seo` set with no `site`, in kay.config.ts or `SITE_URL`, on a `kay build --static` export: no canonical links, `og:url`, sitemap or robots.txt. A server warns at boot instead. |
| `missing-description` | warn | seo | A public site with no `seo.description`. |
| `missing-share-image` | warn | seo | A public site with no `seo.image`, and no `.kay` file of the project setting an `og:image`. |
| `default-favicon` | warn | seo | A public site with no `favicon`, showing kay's mark. |
| `untitled-page` | warn | seo | A prerendered page with no `title`. |
| `undescribed-page` | warn | seo | A prerendered page with no description, its own or `seo.description`. |
| `duplicate-title` | warn | seo | A prerendered page with the title of another of the same locale. |
| `long-description` | warn | seo | A description over 160 characters, which search results cut: `seo.description`, reported in kay.config.ts by `kay check` and `kay build`, or a prerendered page's own, reported at the page by `kay build`. |
| `unsized-share-image` | warn | seo | A prerendered page whose `og:image` has no `og:image:width`, kay reading no size off it. |
| `noindex-in-sitemap` | warn | seo | A prerendered page whose head says `noindex` while the sitemap lists it; `noindex: true` in `page` does both. |
| `long-title` | warn | seo | A prerendered page whose title runs over 60 characters, which search results cut, `seo.titleTemplate` included (`kay check` measures it through the default locale's template, a `raw` title without). |
| `duplicate-description` | warn | seo | A prerendered page with the description of another of the same locale; the `seo.description` every page inherits is left alone. |
| `orphan-page` | warn | seo | A prerendered page no other page links to and the sitemap does not list, reported by `kay build` alone, on a site with `site` set whose own pages are all prerendered: a page of the app rendered per request may link to anything, while the pages a library mounts (kayjs-auth's sign-in, kayjs-cms) link within the library and do not turn it off. The home page, a locale's root, `noindex` pages and guarded pages are left out. |
| `broken-canonical` | warn | seo | A prerendered page whose canonical link points at a page the build rendered as a 404 or a redirect, or at a path `redirects` sends elsewhere; reported by `kay build` alone. |
| `one-way-hreflang` | warn | seo | An alternate (`hreflang`) of a page that does not point back at it from the page it names, or names a page that is not a 200; reported by `kay build` alone, at the page lacking the link back. |
| `redirect-chain` | warn | seo | A redirect in `redirects` or a prerendered redirect whose target redirects again, naming the target to send it to directly; `kay check` reads `redirects` (at the redirect's line in kay.config.ts), `kay build` the redirects it rendered. |
