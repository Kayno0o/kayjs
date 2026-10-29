// Read by every test file or by kay itself rather than imported, so `bun test --changed` cannot follow them.
export const WHOLE_SUITE = /^(?:package\.json|bun\.lock|bunfig\.toml|tsconfig[^/]*\.json|eslint\.(?:config|base|slices)\.ts|src\/(?:.*\/)?[^/]+(?<!\.ts))$/

// A change to a `.ts` or `.kay` file under `src/` or a library's `src/`.
export const SOURCE_CHANGE = /^(?:src|packages\/[^/]+\/src)\/.*\.(?:ts|kay)$/

// Tests scanning the kay and library sources as files, which an import graph does not show. Every one of them reads each source file, so they are the cost of a source change; `tests/land.test.ts` fails for a test scanning the sources that is not listed here.
export const SOURCE_READERS = [
  'tests/api.test.ts',
  'tests/browsers.test.ts',
  'tests/docs.test.ts',
  'tests/errors.test.ts',
  'tests/kept-pages.test.ts',
  'tests/log-prefix.test.ts',
  'tests/markers.test.ts',
  'tests/packages.test.ts',
  'tests/pg-order.test.ts',
  'tests/privacy-storage.test.ts',
  'tests/side-effects.test.ts',
]

// What marks a test as scanning sources: a quoted glob of `src/` or `packages/<library>/src/`, or a scan of the `SRC` folder.
export const SOURCE_SCAN = /[`'"]\{?(?:src\/|packages\/[^`'"]*\/src\/)[^`'"]*\*[*.]|\.scan(?:Sync)?\(SRC\)/

// Tests reading one source file through a fixed path, which neither an import graph nor `SOURCE_READERS` shows: a stylesheet or a component read as text, or loaded by a library's extension (`tests/land.test.ts` derives the `theme.css` list from `UI_THEME_USE`). Each runs only for a change to its file, as the slow and browser tests stay out.
export const SOURCE_FILE_READERS: [RegExp, string[]][] = [
  [/^packages\/ui\/src\/theme\.css$/, ['tests/apply-theme.test.ts', 'tests/format-tailwind.test.ts', 'tests/prune-styles.test.ts', 'tests/inbox.test.ts']],
  [/^packages\/ui\/src\/bell\.kay$/, ['tests/library-context-check.test.ts']],
]

// What marks a test as reading one source file other than a `.ts`: a quoted path of a file in `src/` or `packages/<library>/src/` from the repo root (`../`, `packages/` or `resolve('src/`), on a line reading it.
export const SOURCE_FILE_READ = /(?:Bun\.file|readFile(?:Sync)?)\([^\n]*?[`'"]((?:(?:\.\.\/)+src|(?:\.\.\/)*packages\/[\w-]+\/src|(?<=resolve\([`'"])src)\/[^`'"]*?\.(?!ts\b)[a-z]+)[`'"]/g

// What marks a test as depending on the stylesheet of the UI library: it reads it, loads the UI extension that references it, or imports it from a stylesheet. Browser tests are left out of `SOURCE_FILE_READERS`.
export const UI_THEME_USE = /packages\/ui\/src\/(?:extension|theme\.css)|kayjs-ui\/theme\.css/

// Tests walking every fixture as files, so a new fixture reaches them though no test names it; `tests/land.test.ts` fails for a test walking the fixtures that is not listed here.
export const FIXTURE_WALKERS = [
  'tests/format.test.ts',
  'tests/local-bundle.test.ts',
  'tests/property.test.ts',
  'tests/tree-sitter.test.ts',
]

// What marks a test as walking every fixture: a quoted `tests/fixtures`, or a glob of each fixture under it, or the `.kay` files of its `fixtures` folder.
export const FIXTURE_WALK = /[`'"]tests\/fixtures(?:\/\*[^`'"]*)?[`'"]|findKayFiles\(fixtures\)/

// Tests reading these folders as files, which an import graph does not show.
export const READERS: [RegExp, string[]][] = [
  [/^(?:llms\/|llms\.txt$)/, ['tests/llms.test.ts', 'tests/docs.test.ts', 'tests/docs-chat.test.ts', 'tests/errors.test.ts', 'tests/kay-words.test.ts', 'tests/release-links.test.ts', 'tests/bun.test.ts', 'tests/browsers.test.ts', 'tests/dev-tool.test.ts', 'tests/dev-routes.test.ts']],
  [/^docs\//, ['tests/docs.test.ts', 'tests/examples.test.ts']],
  [/^examples\//, ['tests/examples.test.ts', 'tests/new.test.ts', 'tests/docs.test.ts']],
  [/^packages\//, ['tests/llms.test.ts', 'tests/packages.test.ts', 'tests/docs.test.ts', 'tests/examples.test.ts', 'tests/library.test.ts', 'tests/new.test.ts']],
  // Tests globbing the kay and library sources.
  [SOURCE_CHANGE, SOURCE_READERS],
  ...SOURCE_FILE_READERS,
  // A fixture without a kay.config.ts of its own is part of the repo root's app (src/build/files.ts), so it also reaches a build rooted at the repo.
  [/^tests\/fixtures\//, [...FIXTURE_WALKERS, 'tests/navigation.test.ts']],
  // Greps every tracked file for the private forge domain.
  [/^/, ['tests/public-repo.test.ts']],
]

// The tests reading `path` as a file.
export function readersOf(path: string) {
  return READERS.flatMap(([folder, tests]) => folder.test(path) ? tests : [])
}

const PARENT_STEPS = /^(?:\.\.\/)+/
const BUILT_PART = /\$\{[^}]*\}/g

// The files a path read by a test names: a path built from a variable (`${...}`) stands for every file it can name, none when no file matches.
export async function sourcesRead(path: string, root: string) {
  const fromRoot = path.replace(PARENT_STEPS, '')

  return path.includes('${') ? Array.fromAsync(new Bun.Glob(fromRoot.replaceAll(BUILT_PART, '*')).scan(root)) : [fromRoot]
}
