// What stops a compile, a build, a content load or a static export, named so that `kay explain <code>` can say where its fix is written.
// Each code covers a group of messages with one cause; the registry is the one list a test holds the raise sites, `llms/checks.md` and the docs reference to.

export const ERROR_GROUPS = {
  command: 'A command that could not run: a path that is missing, flags that do not go together.',
  compile: 'A `.kay` file that does not compile: found by `kay check`, `kay build` and `kay dev`.',
  build: 'What stops `kay build`: the browser bundle, workers, icons, libraries, the executable and the config.',
  content: 'A collection that does not load: its entries, its Markdown, its loader and what the editor and the helpers are asked.',
  export: 'A page, endpoint or API module a static export cannot hold, and the directory it writes to.',
} as const

export type ErrorGroup = keyof typeof ERROR_GROUPS

export interface ErrorCode {
  group: ErrorGroup
  summary: string
  // The `llms/` file and the heading of the section that covers the fix.
  fix: { file: string, heading: string }
}

export const ERRORS = {
  'command-usage': {
    group: 'command',
    summary: 'A command that could not run as asked: a path that does not exist or is no project, a flag it does not take, flags that do not go together.',
    fix: { file: 'llms/project.md', heading: 'Commands' },
  },
  'template-syntax': {
    group: 'compile',
    summary: 'A template line kay cannot read: indentation, an unclosed `(` or string, a malformed `for`, `const`, `await` or `match`, an attribute that is neither a quoted string nor a `{expression}`.',
    fix: { file: 'llms/templates.md', heading: 'Template lines' },
  },
  'template-invalid': {
    group: 'compile',
    summary: 'A template that reads but is not allowed: a `head` block in the wrong place, a duplicate id or class, an attribute that has no effect there, a `field`, `server` or `bind:` used wrongly, an event that is not camelCase.',
    fix: { file: 'llms/templates.md', heading: 'Elements' },
  },
  'fence-invalid': {
    group: 'compile',
    summary: 'A script or server fence that breaks a rule of kay: props declared twice or read wrongly, a value exported from a component script, JSX in a fence, a page setting kay cannot read as written.',
    fix: { file: 'llms/components.md', heading: 'File layout' },
  },
  'fence-syntax': {
    group: 'compile',
    summary: 'Code in a fence, or generated from the template, that TypeScript cannot parse.',
    fix: { file: 'llms/components.md', heading: 'File layout' },
  },
  'page-settings-invalid': {
    group: 'compile',
    summary: 'A page setting kay cannot read where it is written: `page` must be an object literal of `key: value` settings.',
    fix: { file: 'llms/routing.md', heading: 'Page settings' },
  },
  'signal-misuse': {
    group: 'compile',
    summary: 'A signal or memo written the wrong way: a memo assigned, a name declared twice, a `bind:` to a name holding no signal.',
    fix: { file: 'llms/components.md', heading: 'Signals' },
  },
  'client-route-fence': {
    group: 'compile',
    summary: 'A page, layout or special page with a `--- client` fence: they render on the server.',
    fix: { file: 'llms/islands.md', heading: 'Islands' },
  },
  'browser-only-read': {
    group: 'compile',
    summary: 'A browser-only name such as `window` read while a component renders on the server too; reported by the type check, so a page still runs.',
    fix: { file: 'llms/islands.md', heading: 'Browser globals on the server' },
  },
  'unknown-lint': {
    group: 'compile',
    summary: 'A `// kay-allow` comment naming something that is no lint.',
    fix: { file: 'llms/checks.md', heading: 'Allow a lint on one line' },
  },
  'browser-builtin-import': {
    group: 'build',
    summary: 'An island importing a module that reaches a Node built-in, which a browser does not have.',
    fix: { file: 'llms/islands.md', heading: 'Browser-only components' },
  },
  'server-only-in-island': {
    group: 'build',
    summary: 'A chunk a page loads reading `process` or `Bun`, or an island importing the server\'s `s` schema builder, so the island dies as it loads.',
    fix: { file: 'llms/islands.md', heading: 'Browser globals on the server' },
  },
  'inert-editor': {
    group: 'build',
    summary: 'An editor component running nothing in the browser, where an editor edits the page.',
    fix: { file: 'llms/content.md', heading: 'The editor' },
  },
  'worker-build': {
    group: 'build',
    summary: 'A worker that fails to build, or starts itself again through other workers.',
    fix: { file: 'llms/styles-and-assets.md', heading: 'Wasm and workers' },
  },
  'glob-import': {
    group: 'build',
    summary: 'An `import.meta.glob` the build cannot read before the module runs.',
    fix: { file: 'llms/components.md', heading: 'Glob imports' },
  },
  'icon-unresolved': {
    group: 'build',
    summary: 'An icon of a set that is not installed, or a name the set does not have.',
    fix: { file: 'llms/styles-and-assets.md', heading: 'Icons' },
  },
  'library-settings': {
    group: 'build',
    summary: '`settings` naming a library that is not installed, declares no settings module, or whose module is missing.',
    fix: { file: 'llms/components.md', heading: 'Using a component library' },
  },
  'executable-invalid': {
    group: 'build',
    summary: '`kay build --compile` without a server entry, or with a public directory named like the client assets.',
    fix: { file: 'llms/project.md', heading: 'Build one executable' },
  },
  'executable-missing-content': {
    group: 'build',
    summary: 'A compiled executable holding no build of a collection.',
    fix: { file: 'llms/project.md', heading: 'Build one executable' },
  },
  'search-page-unreadable': {
    group: 'build',
    summary: 'The search index could not read a prerendered page.',
    fix: { file: 'llms/head.md', heading: 'Site search' },
  },
  'config-default-export': {
    group: 'build',
    summary: 'kay.config.ts that does not export its config by default.',
    fix: { file: 'llms/project.md', heading: 'Project setup' },
  },
  'content-invalid': {
    group: 'content',
    summary: 'Entries of a collection that do not compile or match its schema, a slug two entries share, or a component the collection does not name.',
    fix: { file: 'llms/content.md', heading: 'Collections' },
  },
  'markdown-invalid': {
    group: 'content',
    summary: 'Markdown or data an entry holds that kay cannot read: a component never closed, an attribute kay cannot read, JSON or YAML that does not parse.',
    fix: { file: 'llms/content.md', heading: 'Components in Markdown' },
  },
  'content-config-missing': {
    group: 'content',
    summary: 'The content config the project names does not exist, or a collection is not exported from it.',
    fix: { file: 'llms/content.md', heading: 'Collections' },
  },
  'loader-result': {
    group: 'content',
    summary: 'A collection\'s `load` that threw, did not give an array, or gave an entry with no slug.',
    fix: { file: 'llms/content.md', heading: 'Loaded collections' },
  },
  'loader-method': {
    group: 'content',
    summary: 'An entry saved or removed through a loader that declares no `save` or `remove`.',
    fix: { file: 'llms/content.md', heading: 'Loaded collections' },
  },
  'feed-needs-site': {
    group: 'content',
    summary: 'A feed on a site with no `site` URL to build its links from, or an entry with an invalid date.',
    fix: { file: 'llms/content.md', heading: 'Feeds' },
  },
  'pagination-misuse': {
    group: 'content',
    summary: 'A page size that is not a whole number from 1, or `page()` called when no page renders.',
    fix: { file: 'llms/content.md', heading: 'Pagination' },
  },
  'content-api-misuse': {
    group: 'content',
    summary: 'An editor helper asked for what the collection is not: a locale of a collection that is not localized, a folder collection\'s file from a loaded one, a folder outside the repository or missing.',
    fix: { file: 'llms/content.md', heading: 'A CMS editing the collections' },
  },
  'export-unsupported-config': {
    group: 'export',
    summary: 'A config a static export cannot serve: locales by domain, or an image route resolving images per request.',
    fix: { file: 'llms/routing.md', heading: 'Static export' },
  },
  'export-output-dir': {
    group: 'export',
    summary: 'A static export into a directory that is the project itself, or holds files it did not write.',
    fix: { file: 'llms/routing.md', heading: 'Static export' },
  },
  'export-page-error': {
    group: 'export',
    summary: 'A page, endpoint or module that threw as it was imported or rendered for the export.',
    fix: { file: 'llms/routing.md', heading: 'Static export' },
  },
  'export-page-status': {
    group: 'export',
    summary: 'A page that answers 500, a redirect or a status other than 200 as it is prerendered.',
    fix: { file: 'llms/routing.md', heading: 'Static export' },
  },
  'export-needs-params': {
    group: 'export',
    summary: 'A page with params whose `prerender` lists none, or that sets `prerender: false`, or lists values its matchers refuse.',
    fix: { file: 'llms/routing.md', heading: 'Prerendering' },
  },
  'export-image-route': {
    group: 'export',
    summary: 'A page linking an image only the image route resizes, which no file of the export holds.',
    fix: { file: 'llms/routing.md', heading: 'Static export' },
  },
  'export-site-url': {
    group: 'export',
    summary: 'A page reading the site\'s URL when neither `site` nor SITE_URL sets it.',
    fix: { file: 'llms/head.md', heading: 'Site defaults and social cards' },
  },
  'export-server-render': {
    group: 'export',
    summary: 'A page with something only a server renders per request: a server island, a form stamp or work challenge, a deferred island with no browser entry.',
    fix: { file: 'llms/routing.md', heading: 'Server islands' },
  },
  'export-guard': {
    group: 'export',
    summary: 'A page, endpoint or API module a guard covers, or that `requireGuards` leaves with no guard: only a server runs one per request.',
    fix: { file: 'llms/server.md', heading: 'Guards' },
  },
  'export-action': {
    group: 'export',
    summary: 'A page exporting an action, which only a server can take.',
    fix: { file: 'llms/routing.md', heading: 'Static export' },
  },
  'export-path-clash': {
    group: 'export',
    summary: 'Two pages that would be prerendered to the same file.',
    fix: { file: 'llms/routing.md', heading: 'Prerendering' },
  },
  'export-api-module': {
    group: 'export',
    summary: 'An API module, which answers requests only a server does.',
    fix: { file: 'llms/api-routes.md', heading: 'API modules' },
  },
  'export-no-client-build': {
    group: 'export',
    summary: 'Prerendering run with no client build to add its pages to.',
    fix: { file: 'llms/project.md', heading: 'Commands' },
  },
} as const satisfies Record<string, ErrorCode>

export type ErrorName = keyof typeof ERRORS

export function isErrorCode(name: unknown): name is ErrorName {
  return typeof name === 'string' && Object.hasOwn(ERRORS, name)
}

export function isErrorGroup(name: string | undefined): name is ErrorGroup {
  return name !== undefined && Object.hasOwn(ERROR_GROUPS, name)
}

// An error kay raised itself, its code the one `kay explain` documents.
export class KayError extends Error {
  override name = 'KayError'

  constructor(readonly code: ErrorName, message: string, options?: ErrorOptions) {
    super(message, options)
  }
}

// A problem a static export names, its code leading and the file it is in leading its message.
export interface ExportProblem {
  code: ErrorName
  message: string
}

const KAY_PREFIX = /^kay: /

export function exportProblem(file: string, error: unknown): ExportProblem {
  return { code: errorCodeOf(error) ?? 'export-page-error', message: `${file}: ${error instanceof Error ? error.message.replace(KAY_PREFIX, '') : String(error)}` }
}

// The registered code of what was thrown, when kay raised it.
export function errorCodeOf(failure: unknown): ErrorName | undefined {
  const code = typeof failure === 'object' && failure !== null ? (failure as { code?: unknown }).code : undefined

  return isErrorCode(code) ? code : undefined
}

// What `kay explain` prints for the codes, or the group's.
export function errorList(group?: ErrorGroup): string {
  const entries = Object.entries(ERRORS as Record<ErrorName, ErrorCode>).filter(([, error]) => group === undefined || error.group === group)
  const width = Math.max(...entries.map(([name]) => name.length))
  const groupWidth = Math.max(...Object.keys(ERROR_GROUPS).map(name => name.length))
  const rows = entries.map(([name, error]) => `${name.padEnd(width)}  ${error.group.padEnd(groupWidth)}  ${firstSentence(error.summary)}`).join('\n')

  return group === undefined ? rows : `${group}: ${ERROR_GROUPS[group]}\n\n${rows}`
}

// What `kay explain <code>` prints: what raises it and where the fix is written.
export function explainError(name: ErrorName): string {
  const error: ErrorCode = ERRORS[name]

  return [
    `${name}: an error of ${error.group}, which stops the command raising it`,
    error.summary,
    `The fix is written in ${error.fix.file}, in the section "${error.fix.heading}".`,
  ].join('\n\n')
}

function firstSentence(text: string): string {
  return (/^.*?\.(?=\s|$)/).exec(text)?.[0] ?? text
}
