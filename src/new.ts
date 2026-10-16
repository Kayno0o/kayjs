import type { ConfigSettings, Feature } from './templates'
import { randomBytes } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import process from 'node:process'
import { checklist, select } from './prompt'
import { agentsFile, templateFiles } from './templates'

// The kay this command runs from: a git checkout, which a new project depends on a packed copy of, or the published package.
const KAY_ROOT = resolve(import.meta.dir, '..')
const INVALID_NAME_CHARS = /[^a-z0-9._~-]+/g
const NAME_EDGES = /^[-._~]+|[-._~]+$/g

export type { Feature }

export type Preset = 'blank' | 'server' | 'site' | 'app'

// In the order the picker lists them, each with what it cannot go without.
export const FEATURES: Record<Feature, { description: string, needs: readonly Feature[] }> = {
  server: { description: 'an Elysia server, run in production as one executable; off, a static site built to dist', needs: [] },
  starter: { description: 'a header, a 404 page, and a home page greeting from the server with a counter island', needs: [] },
  tailwind: { description: 'Tailwind over the Catppuccin Mocha palette', needs: [] },
  accents: { description: 'an accent picker in the header, kept in a cookie', needs: ['starter', 'tailwind'] },
  eslint: { description: 'ESLint through @kaynooo/eslint, .kay fences and template expressions included', needs: [] },
  tests: { description: 'bun test through kay/test, with a first test', needs: [] },
  ci: { description: 'a Forgejo workflow checking, linting and testing the server, or publishing the static site to Pages', needs: [] },
  docker: { description: 'a Dockerfile and compose.prod.yaml running the executable, or nginx serving the static site', needs: [] },
  auth: { description: 'sessions, a sign-in, members in Postgres through pg-orm and a guarded /account', needs: ['server'] },
  ws: { description: 'an API module over a websocket, with an island counting the visitors online', needs: ['server'] },
}

export const FEATURE_NAMES = Object.keys(FEATURES) as Feature[]

const SITE: readonly Feature[] = ['starter', 'tailwind', 'accents', 'eslint', 'tests', 'ci', 'docker']

export const PRESETS: Record<Preset, { description: string, features: readonly Feature[] }> = {
  blank: { description: 'one bare page and nothing else', features: [] },
  server: { description: 'an Elysia server run as one executable, styled, linted, tested and containerised', features: ['server', ...SITE] },
  site: { description: 'the same as a static site, published to Pages or served by nginx', features: SITE },
  app: { description: 'the server, plus sessions, members in Postgres and a websocket island', features: ['server', ...SITE, 'auth', 'ws'] },
}

export const PRESET_NAMES = Object.keys(PRESETS) as Preset[]

export interface NewOptions {
  // The \`kay\` dependency: by default the published kay running this command, or a packed copy of the checkout running it.
  kay?: string | undefined
  // What the project holds, the `server` preset's by default; each feature's needs must be among them.
  features?: readonly Feature[] | undefined
}

// What checking or unchecking a feature leaves checked: checking takes what it needs along, unchecking drops what needs it.
export function toggle(features: ReadonlySet<Feature>, feature: Feature): ReadonlySet<Feature> {
  const next = new Set(features)
  const check = (name: Feature) => {
    next.add(name)

    for (const need of FEATURES[name].needs)
      check(need)
  }
  const uncheck = (name: Feature) => {
    next.delete(name)

    for (const other of FEATURE_NAMES) {
      if (next.has(other) && FEATURES[other].needs.includes(name))
        uncheck(other)
    }
  }

  if (next.has(feature))
    uncheck(feature)
  else
    check(feature)

  return next
}

// Asks on the terminal for a preset, then for its features one by one; undefined once the user cancels.
export async function pickFeatures(): Promise<Feature[] | undefined> {
  const preset = await select('Start from', PRESET_NAMES.map(name => ({ value: name, label: name, hint: PRESETS[name].description })), PRESET_NAMES.indexOf('server'))

  if (preset === undefined)
    return undefined

  const features = await checklist('Features', FEATURE_NAMES.map(name => ({ value: name, label: name, hint: FEATURES[name].description })), new Set(PRESETS[preset].features), toggle)

  return features && FEATURE_NAMES.filter(name => features.has(name))
}

// Refuses a target `kay new` would write over: a file, or a directory that already holds files.
export async function refuseTarget(target: string): Promise<void> {
  const dir = resolve(target)

  if (existsSync(dir) && !statSync(dir).isDirectory())
    throw new Error(`kay: ${target} is not a directory`)

  if (existsSync(dir) && (await readdir(dir)).length > 0)
    throw new Error(`kay: ${target} is not empty`)
}

// Scaffolds a project that \`kay dev\` runs and \`kay check\` passes as it is; refuses a directory that already holds files.
export async function createProject(target: string, options: NewOptions = {}): Promise<string[]> {
  const dir = resolve(target)
  const features = new Set(options.features ?? PRESETS.server.features)

  for (const feature of features) {
    const missing = FEATURES[feature].needs.filter(need => !features.has(need))

    if (missing.length > 0)
      throw new Error(`kay: ${feature} needs ${missing.join(' and ')}: add --with ${missing.join(',')}, or drop it with --without ${feature}`)
  }

  await refuseTarget(target)

  const files = await projectFiles(dir, features, options.kay)

  // The session secret in .env is for its owner's eyes only from the moment it is written, which Bun.write cannot do as it ignores a mode.
  await mkdir(dir, { recursive: true })
  await Promise.all(Object.entries(files).map(async ([path, content]) => path === '.env' ? writeFile(join(dir, path), content, { mode: 0o600 }) : Bun.write(join(dir, path), content)))

  return Object.keys(files).sort()
}

// Every file of a project with these features in `dir`, named after it; run from a checkout of kay, packs it into `dir/vendor` for the project to depend on.
export async function projectFiles(dir: string, features: ReadonlySet<Feature>, kayDependency?: string | undefined, settings: ConfigSettings = {}): Promise<Record<string, string>> {
  const has = (feature: Feature) => features.has(feature)
  const name = packageName(basename(dir))
  const kay = await Bun.file(join(KAY_ROOT, 'package.json')).json() as { name: string, version: string, dependencies: Record<string, string>, devDependencies: Record<string, string> }
  // A kay minor may break, so the project takes its patches only.
  const dependency = kayDependency ?? (existsSync(join(KAY_ROOT, '.git')) ? await packKay(join(dir, 'vendor')) : `npm:${kay.name}@~${kay.version}`)
  // An app's tests run each file in modules of its own, so each gets the database tests/database.ts copies for it.
  const scripts = {
    dev: 'kay dev',
    ...has('server') ? { build: 'kay build', compile: 'kay build --compile server', start: 'kay start' } : { build: 'kay build --static' },
    check: 'kay check',
    ...has('eslint') && { 'lint': 'kay lint --cache', 'lint:fix': 'kay lint --fix --cache' },
    fmt: 'kay fmt',
    ...has('tests') && { test: has('auth') ? 'bun test --isolate' : 'bun test' },
    ...has('auth') && { 'db:generate': 'pg-orm generate', 'db:migrate': 'pg-orm apply' },
  }
  const devDependencies = [
    (has('starter') || has('accents')) && '@iconify-json/tabler',
    has('eslint') && '@kaynooo/eslint',
    '@types/bun',
    ...has('tailwind') ? ['bun-plugin-tailwind', 'tailwindcss'] : [],
  ].filter(entry => entry !== false)
  const files: Record<string, string> = {
    ...templateFiles(features, settings),
    'AGENTS.md': agentsFile(scripts),
    'package.json': `${JSON.stringify({
      name,
      type: 'module',
      private: true,
      scripts,
      dependencies: { ...has('auth') && { '@kaynooo/pg-orm': kay.devDependencies['@kaynooo/pg-orm'] }, elysia: kay.dependencies.elysia, kay: dependency },
      devDependencies: Object.fromEntries(devDependencies.map(dev => [dev, kay.devDependencies[dev]!])),
    }, null, 2)}\n`,
    'tsconfig.json': `${JSON.stringify({ extends: 'kay/tsconfig.json' }, null, 2)}\n`,
  }

  // The app's session secret and development database, never committed: the app connects as app_rw, which cannot change the schema, and the migrations as the owner. COMPOSE_FILE makes a bare `docker compose` start that database.
  if (has('auth'))
    files['.env'] = `SESSION_SECRET=${randomBytes(32).toString('hex')}\nDATABASE_URL=postgres://app_rw:app_rw@127.0.0.1:5433/app\nMIGRATE_DATABASE_URL=postgres://app:app@127.0.0.1:5433/app\nCOMPOSE_FILE=compose.dev.yaml\n`

  return Object.fromEntries(Object.entries(files).map(([path, content]) => [path, content.replaceAll('__NAME__', name)]))
}

// What a directory name becomes as a package name, which is also safe to write into a template: lower case letters, digits and `-._~`.
function packageName(directory: string): string {
  return directory.toLowerCase().replace(INVALID_NAME_CHARS, '-').replace(NAME_EDGES, '') || 'app'
}

// A packed copy installs like a published package, its dependencies only; a `file:` folder would drag in its devDependencies too.
// Built and packed from a copy beside the checkout, never in it: `prepack` writing types and dist into the checkout would shadow src for every process type-checking or walking it meanwhile.
async function packKay(vendor: string): Promise<string> {
  const manifest = await Bun.file(join(KAY_ROOT, 'package.json')).json() as { files: string[], devDependencies?: unknown, workspaces?: unknown }
  const stage = await mkdtemp(join(tmpdir(), 'kay-pack-'))

  try {
    // Without the workspace libraries, whose versions only an install of the checkout resolves, and which installing kay never reads.
    delete manifest.devDependencies
    delete manifest.workspaces
    await Bun.write(join(stage, 'package.json'), JSON.stringify(manifest, null, 2))
    await Promise.all(manifest.files.filter(entry => entry !== 'types' && entry !== 'dist').map(async entry => cp(join(KAY_ROOT, entry), join(stage, entry), { recursive: true })))

    const types = Bun.spawn([join(KAY_ROOT, 'node_modules/.bin/tsgo'), '-p', join(KAY_ROOT, 'tsconfig.build.json'), '--outDir', join(stage, 'types')], { stdout: 'pipe', stderr: 'pipe' })
    const [typeErrors, typeWarnings, typesCode, processor] = await Promise.all([new Response(types.stdout).text(), new Response(types.stderr).text(), types.exited, Bun.build({ entrypoints: [join(KAY_ROOT, 'src/eslint/index.ts')], target: 'node', packages: 'external', outdir: join(stage, 'dist'), naming: 'eslint.js' })])

    if (typesCode !== 0 || !processor.success)
      throw new Error(`kay: packing ${KAY_ROOT} failed\n${typeErrors}${typeWarnings}${processor.logs.join('\n')}`)

    // tsgo points each declaration map at the checkout's sources; the package ships its own beside the types, as prepack's maps say.
    for (const name of new Bun.Glob('**/*.d.ts.map').scanSync(join(stage, 'types'))) {
      const path = join(stage, 'types', name)
      const map = await Bun.file(path).json() as { sources: string[] }

      map.sources = map.sources.map(source => relative(dirname(path), join(stage, relative(KAY_ROOT, resolve(dirname(path), source)))))
      await Bun.write(path, JSON.stringify(map))
    }

    const child = Bun.spawn([process.execPath, 'pm', 'pack', '--quiet', '--ignore-scripts', '--destination', vendor], { cwd: stage, stdout: 'pipe', stderr: 'pipe' })
    const [output, errors, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])

    if (code !== 0)
      throw new Error(`kay: packing ${KAY_ROOT} failed\n${errors}`)

    return `file:./vendor/${basename(output.trim())}`
  }
  finally {
    await rm(stage, { recursive: true, force: true })
  }
}
