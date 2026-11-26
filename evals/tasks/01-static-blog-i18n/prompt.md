# Task 01: Localized Static Blog (0 KB JS)

Build a bilingual (`en` and `fr`) static blog using `@kayjs/content` and `@kayjs/i18n` that ships **0 KB of client JavaScript** (`--max-js 0kb`).

## Requirements

1. **Configuration (`kay.config.ts`)**:
   - Configure `site: 'https://example.com'`.
   - Register `@kayjs/i18n` with `locales: ['en', 'fr']`, `defaultLocale: 'en'`, and complete translation dictionaries (`messages`) for both `en` and `fr` (e.g. site title, intro, "Read more", "Back to blog") so `kay check` passes with zero missing translation keys.
   - Register `@kayjs/content` with an RSS feed at `/rss.xml` (`linkPrefix: '/blog'`).

2. **Content Collection (`src/posts.ts` & `src/content/posts/`)**:
   - Define a localized collection with `defineCollection({ dir: 'src/content/posts', localized: true, defaultLocale: 'en', schema })`.
   - Provide a Standard Schema v1 `schema` validating frontmatter (`title: string`, `date: string`, `summary: string`, `tags?: string[]`) without adding external dependencies (a plain `{ '~standard': { version: 1, vendor: 'app', validate(value) { ... } } }` object works natively).
   - Add at least 2 English posts under `src/content/posts/en/*.md` and 2 matching French posts under `src/content/posts/fr/*.md`.

3. **Routes**:
   - `src/routes/index.tsx`: Lists posts for the active locale (`locals.locale ?? 'en'`), displays translated copy via `locals.t`, and includes a language switcher link (`data-no-localize`) between `/` and `/fr`. Export `export const prerender = true`.
   - `src/routes/blog/[slug].tsx`: Renders the matching localized post (`posts.get(params.slug, locale)`), returning `notFound()` when missing. Export `export const prerender = true` and `export function paths()` returning the post URLs (`posts.paths('/blog', 'en')`).

4. **Verification**:
   - `kay check` passes with 0 errors.
   - `kay build --analyze --max-js 0kb` succeeds with **0 B** eager JS on every route.
   - `GET /` serves `<html lang="en">`, `GET /fr` serves `<html lang="fr">`, `GET /rss.xml` serves valid RSS XML, and `GET /blog/nonexistent` returns `404`.
