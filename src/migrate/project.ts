import type { ConfigSettings, Feature } from '../templates'
import type { FontImport, MigratedFile, Note, Role } from './astro'
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { Glob } from 'bun'
import { projectFiles } from '../new'
import { migrateAstro } from './astro'
import { migrateContentConfig } from './content'

// Walks an Astro project: each `.astro` file written as a `.kay` one, pages into `src/routes`, the content config as kay's. Into a directory with no package.json, it also writes the kay project around them and copies the project's other files. Nothing is overwritten.

export interface MigrateReport {
  written: string[]
  // The project's other files under `src` and `public`, copied as they are into another directory.
  copied: string[]
  // Files left alone because the target exists.
  skipped: string[]
  // What was not translated, at its line in the Astro file, with the file written from it.
  notes: { file: string, line: number, target?: string | undefined, message: string }[]
}

const WORD_BOUNDARY = /([a-z0-9])([A-Z])/g
const ACRONYM_BOUNDARY = /([A-Z]+)([A-Z][a-z])/g
const RELATIVE = /^\.\.?\//
const CONTENT_CONFIGS = ['src/content.config.ts', 'src/content/config.ts']
const ENDPOINT = /\.(?:ts|js|mjs)$/
const ASTRO_CONFIGS = ['astro.config.mjs', 'astro.config.ts', 'astro.config.mts', 'astro.config.js']
const SERVER_OUTPUT = /\boutput\s*:\s*['"]server['"]|\badapter\s*:/
// The Astro config's `site` and `base`, their value captured when it is a plain string.
const CONFIG_KEYS = [['site', /\bsite\s*:\s*(?:['"]([^'"\n]+)['"](?=\s*[,}\n]))?/], ['base', /\bbase\s*:\s*(?:['"]([^'"\n]+)['"](?=\s*[,}\n]))?/]] as const
const ASTRO_EXTENSION = /\.astro$/
// Astro's error pages under the names kay gives them.
const ERROR_PAGES = new Map([['404.kay', '_404.kay'], ['500.kay', '_error.kay']])
const MARKDOWN_PAGE = /\.mdx?$/
// Astro, its integrations and its plugins for other tools, which a kay project has no use for.
const ASTRO_PACKAGE = /^(?:astro|astro-.+|.+-astro|@astrojs\/.+|@tailwindcss\/vite)$/
// UnoCSS, which kay has no plugin for: its packages and ESLint plugin are left out, and its classes are listed.
const UNOCSS_PACKAGE = /^(?:unocss|unocss-.+|@unocss\/.+)$/
const UNOCSS_IN_CONFIG = /\bunocss\b/
const UNOCSS_CONFIGS = ['uno.config.ts', 'uno.config.js', 'uno.config.mjs', 'uno.config.mts', 'unocss.config.ts', 'unocss.config.js']
// The Astro project's own ESLint setup, which the `@kaynooo/eslint` config of the project written replaces.
const ESLINT_PACKAGE = /^(?:eslint|eslint-.+|@eslint\/.+|typescript-eslint|@typescript-eslint\/.+|@antfu\/eslint-config|@[^/]+\/eslint-.+)$/
// A .gitignore line's slashes at its ends, which name the same path with or without them.
const IGNORE_EDGE = /^\/|\/$/g
const KAYNOOO_PACKAGE = /^@kaynooo\//
const TAILWIND_3 = /^\D*3\./
// What a source file of the project reads that kay does not: Vite's `import.meta.env` and its `?raw` imports.
const SOURCE_FILE = /\.(?:ts|mts|js|mjs)$/
const META_ENV = /\bimport\.meta\.env\b/
const RAW_IMPORT = /\bfrom\s*['"][^'"]+\?raw['"]/
// The files Astro adds to a .gitignore itself.
const ASTRO_IGNORED = /^\/?(?:\.astro|\.vercel|\.netlify)\/?$/
// The pages and stylesheet of a new project, which the Astro project's own pages and layouts take the place of.
const REPLACED = new Set(['src/routes/_layout.kay', 'src/routes/index.kay', 'src/app.css'])
// Files under `src` the migration writes itself, or that only Astro reads.
const NOT_COPIED = new Set([...CONTENT_CONFIGS, 'src/env.d.ts'])

interface PackageJson {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

export interface MigrateProjectOptions {
  // The `kay` dependency of the project written around the pages, as `kay new --kay` takes it.
  kay?: string | undefined
}

function kebab(name: string): string {
  return name.replace(ACRONYM_BOUNDARY, '$1-$2').replace(WORD_BOUNDARY, '$1-$2').toLowerCase()
}

// Where an `.astro` file goes: a page keeps its path under `src/routes`, `404` becoming `_404`; anything else keeps its folder, its name in kebab-case.
function targetOf(file: string): { path: string, role: Role } {
  if (file.startsWith('src/pages/')) {
    const path = file.slice('src/pages/'.length).replace(ASTRO_EXTENSION, '.kay')

    return { path: join('src/routes', ERROR_PAGES.get(path) ?? path), role: 'page' }
  }

  return { path: join(dirname(file), `${kebab(basename(file, '.astro'))}.kay`), role: 'component' }
}

// The tsconfig `paths`, each target made relative to the project root as kay's tsconfig takes them, and the aliases ending in `/*`, such as `~/*`, as prefix and folder.
async function pathsOf(root: string): Promise<{ paths: Record<string, string[]>, aliases: [string, string][] }> {
  // A tsconfig may hold comments and trailing commas, which Bun's JSONC reader takes.
  const config = await readJson<{ compilerOptions?: { baseUrl?: string, paths?: Record<string, string[]> } }>(join(root, 'tsconfig.json'))
  const base = config?.compilerOptions?.baseUrl ?? '.'
  const paths = Object.fromEntries(Object.entries(config?.compilerOptions?.paths ?? {}).map(([alias, targets]) => [alias, targets.map(target => `./${relative(root, resolve(root, base, target))}`)]))
  const aliases = Object.entries(paths).filter(([alias, targets]) => alias.endsWith('/*') && targets[0]?.endsWith('/*')).map(([alias, targets]): [string, string] => [alias.slice(0, -1), relative(root, resolve(root, targets[0]!.slice(0, -1)))])

  return { paths, aliases }
}

// The line of a package in a package.json, 1 when the file does not name it.
function lineOfPackage(text: string, name: string | undefined): number {
  const index = name === undefined ? -1 : text.indexOf(`"${name}":`)

  return index === -1 ? 1 : text.slice(0, index).split('\n').length
}

// One `fonts` entry per package and style, listing the weights imported; a variable font spans them all.
function fontEntries(imported: FontImport[]): NonNullable<ConfigSettings['fonts']> {
  const groups = new Map<string, { fontsource: string, style: string, subset: string | undefined, weights: Set<number> }>()

  for (const { fontsource, style, subset, weight } of imported) {
    const key = `${fontsource} ${style} ${subset}`
    const group = groups.get(key) ?? { fontsource, style, subset, weights: new Set<number>() }

    if (weight !== undefined)
      group.weights.add(weight)

    groups.set(key, group)
  }

  return [...groups.values()].map(({ fontsource, style, subset, weights }) => ({ fontsource, ...weights.size > 0 && { weights: [...weights].toSorted((a, b) => a - b) }, ...style !== 'normal' && { styles: [style] }, ...subset !== undefined && { subsets: [subset] } }))
}

// The generated .gitignore followed by the lines the Astro project's has that it lacks, Astro's own folders left out.
async function gitignoreWith(generated: string, astroPath: string): Promise<string> {
  const file = Bun.file(astroPath)

  if (!await file.exists())
    return generated

  const have = new Set(generated.split('\n').map(line => line.trim().replace(IGNORE_EDGE, '')))
  const extra = (await file.text()).split('\n').map(line => line.trimEnd()).filter(line => line.trim() !== '' && !line.trim().startsWith('#') && !have.has(line.trim().replace(IGNORE_EDGE, '')) && !ASTRO_IGNORED.test(line.trim()))

  return extra.length === 0 ? generated : `${generated.trimEnd()}\n\n# From the Astro project\n${extra.join('\n')}\n`
}

async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return Bun.JSONC.parse(await Bun.file(path).text()) as T
  }
  catch {
    return undefined
  }
}

// The kay features matching the Astro project: a server when it renders on demand, and the tools it already had.
function featuresOf(root: string, config: string, dependencies: Record<string, string>): Feature[] {
  const features: (Feature | false)[] = [
    SERVER_OUTPUT.test(config) && 'server',
    ('tailwindcss' in dependencies || '@astrojs/tailwind' in dependencies) && 'tailwind',
    ('eslint' in dependencies || '@kaynooo/eslint' in dependencies) && 'eslint',
    existsSync(join(root, '.forgejo/workflows')) && 'ci',
    existsSync(join(root, 'Dockerfile')) && 'docker',
  ]

  return features.filter(feature => feature !== false)
}

// kay's package.json with the Astro project's own packages added, Astro's left out and kay's versions winning.
function withPackages(packageJson: string, astro: PackageJson): string {
  const kay = JSON.parse(packageJson) as PackageJson
  const taken = new Set([...Object.keys(kay.dependencies ?? {}), ...Object.keys(kay.devDependencies ?? {})])
  const linted = taken.has('@kaynooo/eslint')
  const left = (name: string) => ASTRO_PACKAGE.test(name) || UNOCSS_PACKAGE.test(name) || (linted && ESLINT_PACKAGE.test(name)) || taken.has(name)
  const theirs = (packages: Record<string, string> | undefined) => Object.entries(packages ?? {}).filter(([name]) => !left(name))
  const merged = (own: Record<string, string> | undefined, astroPackages: Record<string, string> | undefined) => Object.fromEntries([...Object.entries(own ?? {}), ...theirs(astroPackages)].toSorted(([a], [b]) => a.localeCompare(b)))

  return `${JSON.stringify({ ...kay, dependencies: merged(kay.dependencies, astro.dependencies), devDependencies: merged(kay.devDependencies, astro.devDependencies) }, null, 2)}\n`
}

export async function migrateAstroProject(root: string, out = root, options: MigrateProjectOptions = {}): Promise<MigrateReport> {
  const report: MigrateReport = { written: [], copied: [], skipped: [], notes: [] }
  const files = (await Array.fromAsync(new Glob('src/**/*.astro').scan({ cwd: root }))).toSorted()
  const targets = new Map(files.map(file => [file, targetOf(file)]))
  const { paths, aliases } = await pathsOf(root)
  const note = (file: string, target: string | undefined, { line, message }: Note) => report.notes.push({ file, line, target, message })
  // A directory with no package.json gets a kay project around the pages; one with its own, such as the Astro project, keeps it.
  const scaffold = !existsSync(join(out, 'package.json'))
  const astroText = existsSync(join(root, 'package.json')) ? await Bun.file(join(root, 'package.json')).text() : ''
  const astro = await readJson<PackageJson>(join(root, 'package.json')) ?? {}
  const dependencies = { ...astro.dependencies, ...astro.devDependencies }
  const configFile = ASTRO_CONFIGS.find(file => existsSync(join(root, file)))
  const config = configFile === undefined ? '' : await Bun.file(join(root, configFile)).text()
  let lang: { file: string, target: string, lang: NonNullable<MigratedFile['lang']> } | undefined
  const fonts: { file: string, target: string, font: FontImport }[] = []

  async function write(path: string, content: string | Blob, into = report.written): Promise<boolean> {
    const target = join(out, path)

    if (existsSync(target)) {
      report.skipped.push(path)

      return false
    }

    await mkdir(dirname(target), { recursive: true })
    await Bun.write(target, content)
    into.push(path)

    return true
  }

  for (const file of files) {
    const { path, role } = targets.get(file)!
    // An `.astro` import, relative or through an alias, pointed at the `.kay` file it became.
    const rewriteImport = (specifier: string) => {
      const alias = aliases.find(([prefix]) => specifier.startsWith(prefix))
      const aliased = alias ? join(alias[1], specifier.slice(alias[0].length)) : undefined
      const imported = RELATIVE.test(specifier) ? join(dirname(file), specifier) : aliased
      const target = imported === undefined ? undefined : targets.get(imported)?.path

      if (target === undefined)
        return undefined

      if (alias && !RELATIVE.test(specifier))
        return `${alias[0]}${relative(alias[1], target)}`

      const from = relative(dirname(path), target)

      return from.startsWith('.') ? from : `./${from}`
    }
    const migrated = migrateAstro(await Bun.file(join(root, file)).text(), { role, rewriteImport })

    if (await write(path, migrated.code)) {
      for (const each of migrated.notes)
        note(file, path, each)

      if (migrated.lang && !lang)
        lang = { file, target: path, lang: migrated.lang }

      fonts.push(...migrated.fonts.map(font => ({ file, target: path, font })))
    }
  }

  for (const config of CONTENT_CONFIGS) {
    const file = Bun.file(join(root, config))

    if (!await file.exists())
      continue

    const { code, notes } = migrateContentConfig(await file.text())

    if (await write('src/content.config.ts', code)) {
      for (const each of notes)
        note(config, 'src/content.config.ts', each)
    }

    break
  }

  // Endpoints have no place in the routes folder: kay serves them from its API routes. Markdown pages are a collection's entries in kay.
  for await (const file of new Glob('src/pages/**/*').scan({ cwd: root })) {
    if (ENDPOINT.test(file))
      note(file, undefined, { line: 1, message: 'an Astro endpoint: write it as an API route in src/api/ (see API routes)' })
    else if (MARKDOWN_PAGE.test(file))
      note(file, undefined, { line: 1, message: 'a Markdown page: make it an entry of a content collection and render it from a page (see Content collections)' })
  }

  // Into another directory, the stylesheets, modules, images, content and public files the pages read come along, those beside the pages moving with them into `src/routes`, where kay routes only `.kay` and endpoint files.
  if (resolve(out) !== resolve(root)) {
    for await (const file of new Glob('{src,public}/**/*').scan({ cwd: root, dot: true })) {
      if (file.endsWith('.astro') || NOT_COPIED.has(file))
        continue

      if (!file.startsWith('src/pages/'))
        await write(file, Bun.file(join(root, file)), report.copied)
      else if (!ENDPOINT.test(file) && !MARKDOWN_PAGE.test(file))
        await write(join('src/routes', file.slice('src/pages/'.length)), Bun.file(join(root, file)), report.copied)
    }
  }

  // The project's own modules read Vite's `import.meta.env` and `?raw` imports, which kay does not; they are listed, not rewritten.
  for await (const file of new Glob('src/**/*').scan({ cwd: root })) {
    if (!SOURCE_FILE.test(file))
      continue

    for (const [index, text] of (await Bun.file(join(root, file)).text()).split('\n').entries()) {
      if (META_ENV.test(text))
        note(file, undefined, { line: index + 1, message: 'import.meta.env is Vite\'s: declare the variable in a `defineEnv` schema from `kay/server` and read it from there (see Environment variables), or in `publicEnv` for an island' })

      if (RAW_IMPORT.test(text))
        note(file, undefined, { line: index + 1, message: 'a `?raw` import is Vite\'s: drop the query and write `with { type: \'text\' }` after the specifier' })
    }
  }

  const unoConfig = UNOCSS_CONFIGS.find(file => existsSync(join(root, file)))
  const unoPackage = Object.keys(dependencies).find(name => UNOCSS_PACKAGE.test(name))

  if (unoConfig !== undefined || unoPackage !== undefined || UNOCSS_IN_CONFIG.test(config))
    note(unoConfig ?? 'package.json', undefined, { line: unoConfig === undefined ? lineOfPackage(astroText, unoPackage) : 1, message: 'UnoCSS: kay has no UnoCSS plugin, so its packages are left out and a class only UnoCSS knows passes through unstyled (variant groups such as `group-even:(top-0 -translate-y-full)`, a custom variant, shortcuts, theme colors, attributify, a number for a colour shade such as `text-red-5`); port them to Tailwind 4 with `@theme`, `@custom-variant` and `@apply` in the stylesheet' })

  if (TAILWIND_3.test(dependencies.tailwindcss ?? '') || '@astrojs/tailwind' in dependencies)
    note('package.json', undefined, { line: 1, message: 'Tailwind 3: kay builds stylesheets with Tailwind 4 through bun-plugin-tailwind; upgrade them with `bunx @tailwindcss/upgrade`' })

  const settings: ConfigSettings = { lang: lang?.lang.value, seo: false }
  const served = fontEntries(fonts.map(({ font }) => font))

  if (scaffold) {
    settings.fonts = served
  }
  else {
    // The stylesheets stay imported in place: listing them is all a project written over its own folder can do.
    for (const { file, target, font } of fonts)
      note(file, target, { line: font.line, message: `${font.fontsource}${font.weight === undefined ? '' : ` ${font.weight}${font.style === 'italic' ? ' italic' : ''}`} was a Fontsource stylesheet kay migrate removed: serve it with \`fonts: [{ fontsource: '${font.fontsource}' }]\` in kay.config.ts` })
  }

  // `site` and `base` carry over when the Astro config writes them as strings; any other value is listed for kay.config.ts.
  for (const [key, pattern] of CONFIG_KEYS) {
    const match = pattern.exec(config)

    if (match === null || configFile === undefined)
      continue

    const line = config.slice(0, match.index).split('\n').length

    if (match[1] === undefined)
      note(configFile, undefined, { line, message: `\`${key}\` is not a string kay migrate reads: set it in kay.config.ts` })
    else if (scaffold)
      settings[key] = match[1]
    else
      note(configFile, undefined, { line, message: `\`${key}\`: set \`${key}: '${match[1]}'\` in kay.config.ts` })
  }

  if (scaffold) {
    const project = await projectFiles(out, new Set(featuresOf(root, config, dependencies)), options.kay, settings)

    const carried = withPackages(project['package.json']!, astro)
    const own = JSON.parse(project['package.json']!) as PackageJson
    const written = JSON.parse(carried) as PackageJson

    project['package.json'] = carried

    // A `@kaynooo/*` range the registry the .npmrc names may hold no version of, which fails `bun install`.
    for (const [name, range] of Object.entries({ ...written.dependencies, ...written.devDependencies }).filter(([name]) => KAYNOOO_PACKAGE.test(name) && !(name in { ...own.dependencies, ...own.devDependencies })))
      note('package.json', undefined, { line: lineOfPackage(astroText, name), message: `\`${name}@${range}\` is carried over, and the Forgejo registry the .npmrc names may hold no version in that range: if \`bun install\` fails with No version matching, change the range to a published one` })

    if (Object.keys(paths).length > 0)
      project['tsconfig.json'] = `${JSON.stringify({ extends: 'kay/tsconfig.json', compilerOptions: { paths } }, null, 2)}\n`

    // The Astro project's ignored paths (a data folder, ignored files under public) join the ones kay's project ignores.
    project['.gitignore'] = await gitignoreWith(project['.gitignore']!, join(root, '.gitignore'))

    for (const [path, content] of Object.entries(project)) {
      if (!REPLACED.has(path))
        await write(path, content)
    }
  }
  else {
    if (lang)
      note(lang.file, lang.target, { line: lang.lang.line, message: `\`lang\` on html: set \`lang: '${lang.lang.value}'\` in kay.config.ts, which writes it on every page` })

    if (Object.keys(paths).length > 0)
      note('tsconfig.json', undefined, { line: 1, message: `the code imports through ${Object.keys(paths).join(', ')}: keep \`paths\` in the kay project's tsconfig.json` })

    if (resolve(out) === resolve(root)) {
      const astroPackages = Object.keys(dependencies).filter(name => ASTRO_PACKAGE.test(name)).toSorted()

      note('package.json', undefined, { line: 1, message: `the Astro project's, left as it is: add the \`kay\` dependency \`kay new\` writes, run \`kay dev\`, \`kay build\` and \`kay check\` from its scripts${astroPackages.length > 0 ? ` and remove ${astroPackages.join(', ')}` : ''}; or migrate into an empty directory with --outdir, which writes it` })
    }
  }

  report.notes.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)

  return report
}
