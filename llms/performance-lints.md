# Performance lints

## Common tasks

- Give every `img` a `width` and `height`, or import the image so kay reads its size (`unsized-image`).
- Load independent data together: `const [a, b] = await Promise.all([loadA(), loadB()])`, a guard such as `await requireUser()` kept in its own statement first (`serial-awaits`).
- Import an image over 256 KiB from `src/` rather than serving it from `public/`, so kay sends it resized as WebP (`large-public-image`).

## Reference

- The `performance` group reads what makes a page shift as it loads or load more than it shows; each lint is set in `lints` like any other ([Lints and warnings](lints.md)).

| Lint | Default | Group | Reports |
| --- | --- | --- | --- |
| `unsized-image` | warn | performance | An `img` or `input(type="image")` with neither `width` and `height` nor a spread that may carry them, so the page shifts as it loads; an imported PNG, JPEG, WebP, GIF or AVIF as `src={name}` and a stored file's `files.url(key)` alone are sized by kay; an SVG, a path, a value from data, an image with its own `srcset` or one size still warns; static `aspect-*` with a width or height, `w-*` with `h-*`, `size-*` or a `style` `aspect-ratio` reserve the box, a variant or a bound class does not. No fix: write the image's size. |
| `serial-awaits` | warn | performance | Two or more consecutive top-level `const x = await ...` statements of a `--- server` fence where no awaited expression reads a name an earlier one of the run declares, so the page takes the sum of their times. A pattern, a type annotation, `let`, a `try`, a statement or comment between two awaits and an expression reading an earlier binding end the run and are left alone. The fix, `const [a, b] = await Promise.all([...])`, is offered in the editor but is not safe, so `kay check --fix` leaves it: it starts the awaits together, so a guard (`await requireUser()`, anything that redirects or throws) stays in its own statement before them. |
| `large-public-image` | warn | performance | A static `img` `src`, a CSS `url()` or `image-set()` string, an `og:image` or `twitter:image` `meta`, `seo.image`, or a Markdown image, reference image, HTML `img` or frontmatter `image:` (CSS comments and Markdown code left out; an address under `site` counts) that names a PNG, JPEG, GIF, WebP, AVIF or BMP in `public/` over 256 KiB, sent whole as public files are. No fix: import it from `src/` so kay serves it resized as WebP; an `img` with its own `srcset` or a `src` written as an expression is left alone. Reported by `kay check` and `kay build`, set with `lints` only. |
