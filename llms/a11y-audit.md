# Audit a site's accessibility

`kay a11y [dir] [--standard rgaa|wcag] [--declaration <file>] [--dry-run] [--format text|json] [--quiet]` boots the project's server as `kay dev` does, opens every page the build knows in one headless Chrome (`BUN_CHROME_PATH`, else the PATH) and runs axe-core on it, which the app installs as a dev dependency ([peers](checks.md#peer-packages)); it needs no config:

```sh
kay a11y
kay a11y --standard wcag --declaration docs/accessibility.md
```

- A page without params is opened once per locale; a page with params for the values its `prerender` (else `sitemap`) export lists, `base` and `trailingSlash` applied.
- A page that redirects (a sign-in) or answers 401, 403 or 404 is listed as not audited, as is a page with params and no list, or a locale served on its own domain. A page that answers 5xx, cannot be listed or cannot be checked fails the run.
- Findings are grouped by rule, then by page, each element with its `.kay` file, line and column where the dev build marked it (shadow roots are not).
- The statement draft is Markdown, written to `.kay/a11y/declaration.md` or `--declaration` (not with `--dry-run`): the pages audited and left out, every criterion of RGAA 4.1 (French, the default when the default locale is `fr`) or WCAG 2.1 (English) marked `verified`, `failed` or `review`, the failures with their elements, and the findings no criterion takes in. Only criteria whose every test an axe-core rule decides are verified, and only when every page was audited (RGAA 8.3 and 8.5, no WCAG one); a run that audited no page fails, a criterion fails by the rules listed in `src/a11y/standards.ts`, and every other one is left for a manual audit, which a declaration needs.
- The exit code is 1 on any finding or failed page, 0 otherwise. `--format json` prints the whole report on one line, with `failure` naming why a run that audited no page failed.
