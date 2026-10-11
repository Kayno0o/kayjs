import type { ConfigSettings, Feature } from '../templates'
import type { MigratedFile, Note, Role } from './astro'
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
const CONFIG_SITE = /\bsite\s*:\s*['"]([^'"]+)['"]/
const CONFIG_BASE = /\bbase\s*:\s*['"]([^'"]+)['"]/
// Astro, its integrations and its plugins for other tools, which a kay project has no use for.
const ASTRO_PACKAGE = /^(?:astro|astro-.+|.+-astro|@astrojs\/.+|@tailwindcss\/vite)$/
const TAILWIND_3 = /^\D*3\./
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
    const path = file.slice('src/pages/'.length).replace(/\.astro$/, '.kay')

    return { path: join('src/routes', path === '404.kay' ? '_404.kay' : path === '500.kay' ? '_error.kay' : path), role: 'page' }
  }

  return { path: join(dirname(file), `${kebab(basename(file, '.astro'))}.kay`), role: 'component' }
}

// The tsconfig `paths` aliases ending in `/*`, such as `~/*`, as prefix and folder.
async function aliasesOf(root: string): Promise<[string, string][]> {
  const file = Bun.file(join(root, 'tsconfig.json'))

  if (!await file.exists())
    return []

  try {
    // A tsconfig may hold comments and trailing commas, which Bun's JSONC reader takes.
    const config = Bun.JSONC.parse(await file.text()) as { compilerOptions?: { baseUrl?: string, paths?: Record<string, string[]> } }
    const base = config.compilerOptions?.baseUrl ?? '.'

    return Object.entries(config.compilerOptions?.paths ?? {}).filter(([alias, targets]) => alias.endsWith('/*') && targets[0]?.endsWith('/*')).map(([alias, targets]) => [alias.slice(0, -1), relative(root, resolve(root, base, targets[0]!.slice(0, -1)))])
  }
  catch {
    return []
  }
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
  const theirs = (packages: Record<string, string> | undefined) => Object.entries(packages ?? {}).filter(([name]) => !ASTRO_PACKAGE.test(name) && !taken.has(name))
  const merged = (own: Record<string, string> | undefined, astroPackages: Record<string, string> | undefined) => Object.fromEntries([...Object.entries(own ?? {}), ...theirs(astroPackages)].toSorted(([a], [b]) => a.localeCompare(b)))

  return `${JSON.stringify({ ...kay, dependencies: merged(kay.dependencies, astro.dependencies), devDependencies: merged(kay.devDependencies, astro.devDependencies) }, null, 2)}\n`
}

export async function migrateAstroProject(root: string, out = root, options: MigrateProjectOptions = {}): Promise<MigrateReport> {
  const report: MigrateReport = { written: [], copied: [], skipped: [], notes: [] }
  const files = (await Array.fromAsync(new Glob('src/**/*.astro').scan({ cwd: root }))).toSorted()
  const targets = new Map(files.map(file => [file, targetOf(file)]))
  const aliases = await aliasesOf(root)
  const note = (file: string, target: string | undefined, { line, message }: Note) => report.notes.push({ file, line, target, message })
  // A directory with no package.json gets a kay project around the pages; one with its own, such as the Astro project, keeps it.
  const scaffold = !existsSync(join(out, 'package.json'))
  const astro = await readJson<PackageJson>(join(root, 'package.json')) ?? {}
  const dependencies = { ...astro.dependencies, ...astro.devDependencies }
  const configFile = ASTRO_CONFIGS.find(file => existsSync(join(root, file)))
  const config = configFile === undefined ? '' : await Bun.file(join(root, configFile)).text()
  let lang: { file: string, target: string, lang: NonNullable<MigratedFile['lang']> } | undefined

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
      const imported = RELATIVE.test(specifier) ? join(dirname(file), specifier) : alias ? join(alias[1], specifier.slice(alias[0].length)) : undefined
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

  // Endpoints have no place in the routes folder: kay serves them from its API routes.
  for await (const endpoint of new Glob('src/pages/**/*').scan({ cwd: root })) {
    if (ENDPOINT.test(endpoint))
      note(endpoint, undefined, { line: 1, message: 'an Astro endpoint: write it as an API route in src/api/ (see API routes)' })
  }

  // Into another directory, the stylesheets, modules, images, content and public files the pages read come along.
  if (resolve(out) !== resolve(root)) {
    for await (const file of new Glob('{src,public}/**/*').scan({ cwd: root, dot: true })) {
      if (!file.endsWith('.astro') && !file.startsWith('src/pages/') && !NOT_COPIED.has(file))
        await write(file, Bun.file(join(root, file)), report.copied)
    }
  }

  if (TAILWIND_3.test(dependencies.tailwindcss ?? '') || '@astrojs/tailwind' in dependencies)
    note('package.json', undefined, { line: 1, message: 'Tailwind 3: kay builds stylesheets with Tailwind 4 through bun-plugin-tailwind; upgrade them with `bunx @tailwindcss/upgrade`' })

  if (scaffold) {
    const settings: ConfigSettings = { lang: lang?.lang.value, site: CONFIG_SITE.exec(config)?.[1], base: CONFIG_BASE.exec(config)?.[1], seo: false }
    const project = await projectFiles(out, new Set(featuresOf(root, config, dependencies)), options.kay, settings)

    project['package.json'] = withPackages(project['package.json']!, astro)

    if (aliases.length > 0)
      project['tsconfig.json'] = `${JSON.stringify({ extends: 'kay/tsconfig.json', compilerOptions: { paths: Object.fromEntries(aliases.map(([prefix, folder]) => [`${prefix}*`, [`./${folder}/*`]])) } }, null, 2)}\n`

    for (const [path, content] of Object.entries(project)) {
      if (!REPLACED.has(path))
        await write(path, content)
    }
  }
  else {
    if (lang)
      note(lang.file, lang.target, { line: lang.lang.line, message: `\`lang\` on html: set \`lang: '${lang.lang.value}'\` in kay.config.ts, which writes it on every page` })

    if (aliases.length > 0)
      note('tsconfig.json', undefined, { line: 1, message: `the code imports through ${aliases.map(([prefix]) => `${prefix}*`).join(', ')}: keep \`paths\` in the kay project's tsconfig.json` })

    if (resolve(out) === resolve(root))
      note('package.json', undefined, { line: 1, message: 'the Astro project\'s, left as it is: give it the scripts and dependencies `kay new` writes, or migrate into an empty directory with --out, which writes them' })
  }

  report.notes.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)

  return report
}
