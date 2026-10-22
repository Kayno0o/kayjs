# Errors

## Common tasks

### Look up an error code

An error that is no lint prints its code in brackets, and `kay explain` says where the fix is written:

```sh
kay explain template-syntax
```

## Reference

### Errors

- A compile, build, content or export error that is no lint carries a code too, printed in brackets, `error[template-syntax]`, or after the failure, `kay explain <code> says where the fix is written`.
- `kay check --format json`, `kay build --format json` and `kay explain --format json` carry it as `code`, which is `null` for what kay did not raise at compile, build, content or export time, such as a type error TypeScript names by number.
- `kay explain <code>` prints what raises it and the section that covers the fix; `kay explain compile`, `command`, `build`, `content` or `export` lists a group's.
- The codes are stable names, one for a group of messages with one cause.
- No level applies to them, and no `// kay-allow` comment reaches them.
- Errors kay raises while serving a request, and the app's own code, carry none.
- Every error class kay exports ends in `Error`, as a library's does (`HydrationMismatchError` of `kay/dom`, `ActionRedirectError` from `kay`, `CspViolationError` from `kay/server`, `RedirectRefusedError` of `kay/library`, their `name` too); the old names stay `@deprecated` aliases three minors, and `kay upgrade` renames them.

| Error | Group | Raised for | Fix |
| --- | --- | --- | --- |
| `command-usage` | command | A command that could not run as asked: a path that does not exist or is no project, a flag it does not take, flags that do not go together. | [Commands](project.md#commands) |
| `extension-command` | command | A command an extension adds to `kay` whose module does not load or does not export a `KayCommand` by default. | [Extensions](component-libraries.md#extensions) |
| `template-syntax` | compile | A template line kay cannot read: indentation, an unclosed `(` or string, a malformed `for`, `const`, `await` or `match`, an attribute that is neither a quoted string nor a `{expression}`. | [Template lines](templates.md#template-lines) |
| `template-invalid` | compile | A template that reads but is not allowed: a `head` block in the wrong place, a duplicate id or class, an attribute that has no effect there, a `field`, `server` or `bind:` used wrongly, an event that is not camelCase. | [Elements](templates.md#elements) |
| `fence-invalid` | compile | A fence that breaks a rule of kay: a fence never closed or declared twice, props declared twice or read wrongly, a value exported from a component script, JSX in a fence, `page` not written as an object literal of `key: value` settings, a `guards` or `layouts` in it that is no literal `true` or `false`. | [File layout](components.md#file-layout) |
| `fence-syntax` | compile | Code in a fence that does not parse, or code the template generates that does not. | [File layout](components.md#file-layout) |
| `page-settings-invalid` | compile | A page setting exported under its own name instead of inside `page`, such as `export const prerender = true`, or a `guards` or `layouts` that an endpoint or an API module sets to anything but a literal `true` or `false`. | [Page settings](routing.md#page-settings) |
| `signal-misuse` | compile | A signal or memo written the wrong way: a memo assigned, a name declared twice, a `bind:` to a name holding no signal. | [Signals](components.md#signals) |
| `client-route-fence` | compile | A page, layout or special page with a `--- client` fence: they render on the server. | [Islands](islands.md#islands) |
| `browser-only-read` | compile | A browser-only name such as `window` read while a component renders on the server too; reported by the type check, so a page still runs. | [Browser globals on the server](browser-only.md#browser-globals-on-the-server) |
| `unknown-lint` | compile | A `// kay-allow` comment naming something that is no lint. | [Allow a lint on one line](lints.md#allow-a-lint-on-one-line) |
| `browser-builtin-import` | build | An island importing a module that reaches a Node built-in, which a browser does not have. | [Browser-only components](browser-only.md#browser-only-components) |
| `server-only-in-island` | build | A chunk a page loads reading `process` or `Bun`, or an island importing the server's `s` schema builder, so the island dies as it loads. | [Browser globals on the server](browser-only.md#browser-globals-on-the-server) |
| `inert-editor` | build | An editor component running nothing in the browser, where an editor edits the page. | [The editor](content-edit.md#the-editor) |
| `worker-build` | build | A worker that fails to build, or starts itself again through other workers. | [Wasm and workers](imported-files.md#wasm-and-workers) |
| `glob-import` | build | An `import.meta.glob` the build cannot read before the module runs. | [Glob imports](components.md#glob-imports) |
| `icon-unresolved` | build | An icon of a set that is not installed, or a name the set does not have. | [Icons](images.md#icons) |
| `library-settings` | build | `settings` naming a library that is not installed, declares no settings module, or whose module is missing. | [Using a component library](component-libraries.md#using-a-component-library) |
| `executable-invalid` | build | `kay build --compile` without a server entry, or with a public directory named like the client assets. | [Build one executable](build-and-start.md#build-one-executable) |
| `executable-failed` | build | A compiled executable that `kay build --compile --verify` started and that exited, or never answered its health route, or that `--verify-load` could not load, with its own output. | [Check the executable starts](production.md#check-the-executable-starts) |
| `executable-incomplete` | build | A compiled executable that lacks a part of what it needs: the build of a collection, the client build, its fonts or a share card key. | [Build one executable](build-and-start.md#build-one-executable) |
| `route-invalid` | build | A route file the router cannot serve: a name with characters it cannot mount, a matcher, guard, endpoint or API module that exports the wrong thing, two files exporting the same action, or two extensions each giving an editor. | [Pages and routing](routing.md#pages-and-routing) |
| `redirect-invalid` | build | A redirect in `redirects` that does not start with `/`, holds something other than a `:param` or a final `*`, or goes to a path using a part its source lacks. | [Redirects](routing-endpoints-and-base.md#redirects) |
| `locales-invalid` | build | An `i18n` config that does not hold together: no locales, a tag that is none, a default outside the locales, domains and `prefixDefault` together, `paths` naming a page that does not exist, a catalog that exports no messages or not as `defineMessages`, or `writeDraftMessages` given a locale the config does not translate. | [Configuring locales](locales.md#configuring-locales) |
| `font-invalid` | build | A font in `fonts` that is no font file, no installed Fontsource package, or lacks the weight, style or subset asked for. | [Fonts](sitemap-search-fonts.md#fonts) |
| `favicon-invalid` | build | A favicon, manifest icon or SVG that is no SVG kay can draw, has no size, is not square, or a manifest path outside its scope. | [Favicon and web manifest](sitemap-search-fonts.md#favicon-and-web-manifest) |
| `share-card-invalid` | build | A share card drawn with no font, a logo that is missing, not square or not an image kay draws, a colour that is no #rrggbb, or an empty title. | [Draw a share card for a page](images.md#draw-a-share-card-for-a-page) |
| `image-invalid` | build | An image the build cannot fetch, or `images` settings that do not go together: `guard` with no `resolve`, a box given both a width and a height. | [Responsive images](images.md#responsive-images) |
| `env-invalid` | build | The environment does not match its schema. | [Environment](environment.md#environment) |
| `config-invalid` | build | A setting in kay.config.ts or a call that configures the server that kay refuses: `base`, `site`, `cors`, `preview`, `session`, `proxy`, `rateLimit`, a queue, a schedule, a size, a file store asked for what it does not hold, or an option of a library (kayjs-auth, kayjs-cms, kayjs-mail, kayjs-ai) that it refuses at boot. | [Project setup](project.md#project-setup) |
| `export-private-file` | export | A static export linking a private or stored file, which only a server can serve. | [Static export](prerendering.md#static-export) |
| `search-page-unreadable` | build | The search index could not read a prerendered page. | [Site search](sitemap-search-fonts.md#site-search) |
| `config-default-export` | build | kay.config.ts that does not export its config by default. | [Project setup](project.md#project-setup) |
| `content-invalid` | content | Entries of a collection that do not compile or match its schema, a slug two entries share, a component the collection does not name, or a feed entry with an invalid date. | [Collections](content.md#collections) |
| `markdown-invalid` | content | Markdown or data an entry holds that kay cannot read: a component never closed, a component tag or attribute kay cannot read, JSON or YAML that does not parse. | [Components in Markdown](content.md#components-in-markdown) |
| `content-config-missing` | content | The content config the project names does not exist, or a collection is not exported from it. | [Collections](content.md#collections) |
| `loader-result` | content | A collection's `load` that threw, did not give an array, or gave an entry with no slug. | [Loaded collections](content-cms.md#loaded-collections) |
| `loader-method` | content | An entry saved or removed through a loader that declares no `save` or `remove`. | [Loaded collections](content-cms.md#loaded-collections) |
| `feed-needs-site` | content | A feed on a site with no `site` URL to build its links from. | [Feeds](content.md#feeds) |
| `pagination-misuse` | content | A page size that is not a whole number from 1, or `page()` called when no page renders. | [Pagination](content.md#pagination) |
| `content-api-misuse` | content | An editor helper asked for what the collection is not: a locale of a collection that is not localized, a folder collection's file from a loaded one, a folder outside the repository or missing. | [A CMS editing the collections](content-cms.md#a-cms-editing-the-collections) |
| `export-unsupported-config` | export | A config a static export cannot serve: locales by domain, or an image route resolving images per request. | [Static export](prerendering.md#static-export) |
| `export-output-dir` | export | A static export into a directory that is the project itself, or holds files it did not write. | [Static export](prerendering.md#static-export) |
| `export-page-error` | export | A page, endpoint or module that threw as it was imported or rendered for the export. | [Static export](prerendering.md#static-export) |
| `export-page-status` | export | A page that answers 500, a redirect or a status other than 200 as it is prerendered. | [Static export](prerendering.md#static-export) |
| `export-needs-params` | export | A page with params whose `prerender` lists none, or that sets `prerender: false`, or lists values its matchers refuse. | [Prerendering](prerendering.md#prerendering) |
| `export-image-route` | export | A page linking an image only the image route resizes, which no file of the export holds. | [Static export](prerendering.md#static-export) |
| `export-site-url` | export | A page reading the site's URL when neither `site` nor SITE_URL sets it. | [Site defaults and social cards](head.md#site-defaults-and-social-cards) |
| `export-server-render` | export | A page with something only a server renders per request: a server island, a form stamp or work challenge, a live value, a deferred island with no browser entry. | [Server islands](prerendering.md#server-islands) |
| `export-guard` | export | A page or endpoint a guard covers, or that `requireGuards` leaves with no guard: only a server runs one per request. | [Guards](server.md#guards) |
| `export-action` | export | A page exporting an action, which only a server can take. | [Static export](prerendering.md#static-export) |
| `export-path-clash` | export | Two pages that would be prerendered to the same file. | [Prerendering](prerendering.md#prerendering) |
| `export-api-module` | export | An API module, which answers requests only a server does. | [API modules](api-routes.md#api-modules) |
| `export-no-client-build` | export | Prerendering run with no client build to add its pages to. | [Commands](project.md#commands) |
