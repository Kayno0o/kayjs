import type { Note, Role } from './astro'
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { Glob } from 'bun'
import { migrateAstro } from './astro'
import { migrateContentConfig } from './content'

// Walks an Astro project: each `.astro` file written as a `.kay` one, pages into `src/routes`, the content config as kay's. Nothing is overwritten.

export interface MigrateReport {
  written: string[]
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

export async function migrateAstroProject(root: string, out = root): Promise<MigrateReport> {
  const report: MigrateReport = { written: [], skipped: [], notes: [] }
  const files = (await Array.fromAsync(new Glob('src/**/*.astro').scan({ cwd: root }))).toSorted()
  const targets = new Map(files.map(file => [file, targetOf(file)]))
  const aliases = await aliasesOf(root)
  const note = (file: string, target: string | undefined, { line, message }: Note) => report.notes.push({ file, line, target, message })

  async function write(path: string, code: string): Promise<boolean> {
    const target = join(out, path)

    if (existsSync(target)) {
      report.skipped.push(path)

      return false
    }

    await mkdir(dirname(target), { recursive: true })
    await Bun.write(target, code)
    report.written.push(path)

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
    const { code, notes } = migrateAstro(await Bun.file(join(root, file)).text(), { role, rewriteImport })

    if (await write(path, code)) {
      for (const each of notes)
        note(file, path, each)
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

  if (aliases.length > 0)
    note('tsconfig.json', undefined, { line: 1, message: `the code imports through ${aliases.map(([prefix]) => `${prefix}*`).join(', ')}: keep \`paths\` in the kay project's tsconfig.json` })

  report.notes.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)

  return report
}
