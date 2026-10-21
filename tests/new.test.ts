import type { Feature } from '../src/new'
import { chmod, cp, mkdir, mkdtemp, readdir, rm, stat, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, posix, relative } from 'node:path'
import process from 'node:process'
import { afterAll, describe, expect, it, spyOn } from 'bun:test'
import { parse, stringify } from 'devalue'
import { ASSET_PREFIX, clientDir, outputDir } from '../src/build/assets'
import { buildClient } from '../src/build/client'
import { NOTICES_FILE } from '../src/build/licenses'
import { check, configCheckOptions } from '../src/check'
import { runCommand } from '../src/commands/command'
import { USAGES } from '../src/commands/usages'
import { nativeExe } from '../src/compiler/native-typescript'
import { loadConfig } from '../src/config'
import { formatFiles } from '../src/format'
import { createProject, detectHost, FEATURE_NAMES, PRESETS, toggle } from '../src/new'
import { SEARCH_MANIFEST } from '../src/runtime/search'
import { TAILWIND_CLASS_REGEX } from '../src/templates'
import { listeningPort } from './listening'
import { lintInProcess } from './scaffold-lint'

const repo = join(import.meta.dir, '..')
const LISTENING = /localhost:(\d+)/
// Top-level imports of the Node modules a compiled server loads only once a feature needs them.
const EAGER_BUILTINS = [...['zlib', 'crypto', 'http', 'net'].flatMap(name => [`from "${name}"`, `from "node:${name}"`]), 'from "bun:sqlite"']
// A Postgres whose user may create databases, for the scaffolded app's tests: CI sets it, as pg-orm's own tests have one.
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL
// A scaffold installed, checked, linted, tested and built: about 30 s in CI, and past 60 s there under a loaded parallel run.
const SCAFFOLD_MS = 120_000
const ACCENT_TEST = `import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { expect, it } from 'bun:test'
import { mountComponent, settle, testSite } from 'kay/test'
import { encodeValue } from __WIRE__

const site = await testSite()
const accentStyle = async (value: string) => (await site.visit('/', { headers: { cookie: \`accent=\${encodeURIComponent(encodeValue(value))}\` } })).html

it('renders the kept accent from the first paint, a known one only', async () => {
  expect(await accentStyle('mauve')).toContain('<style>:root { --accent: var(--accent-mauve); }</style>')
  expect(await accentStyle('x); } body { display: none')).toContain('<style>:root { --accent: var(--accent-peach); }</style>')
})

it('changes the accent on a click', async () => {
  // A page of a site, whose cookies the document keeps.
  GlobalRegistrator.register({ url: 'http://localhost/' })

  try {
    const { root, unmount } = await mountComponent('src/components/accent-picker.kay')

    root.querySelector<HTMLButtonElement>('[aria-label="mauve"]')!.click()
    await settle()

    expect(root.querySelector('style')!.textContent).toBe(':root { --accent: var(--accent-mauve); }')
    expect(root.querySelector('[aria-label="mauve"]')!.getAttribute('aria-checked')).toBe('true')
    expect(document.cookie).toContain('accent=')
    unmount()
  }
  finally {
    await GlobalRegistrator.unregister()
  }
})
`

// The contents each path takes in each preset, to tell what another scaffold generates differently.
let presetContents: Promise<Map<string, Map<string, string>>> | undefined

async function presetFiles(): Promise<Map<string, Map<string, string>>> {
  presetContents ??= (async () => {
    const seen = new Map<string, Map<string, string>>()

    for (const [name, preset] of Object.entries(PRESETS)) {
      const dir = join(await mkdtemp(join(tmpdir(), 'kay-preset-')), 'my-app')

      try {
        const files = await createProject(dir, { kay: '^1.0.0', features: preset.features })

        seen.set(name, new Map(await Promise.all(files.map(async file => [file, await Bun.file(join(dir, file)).text()] as const))))
      }
      finally {
        await rm(join(dir, '..'), { recursive: true, force: true })
      }
    }

    return seen
  })()

  return presetContents
}

// The files of a scaffold that none of the presets `among` write as they are: what their own runs have not checked, linted or tested.
async function ownFiles(dir: string, files: string[], among: string[] = Object.keys(PRESETS)): Promise<string[]> {
  const presets = (await presetFiles()).entries().filter(([name]) => among.includes(name)).map(([, contents]) => contents).toArray()
  const own = await Promise.all(files.map(async (file) => {
    const text = await Bun.file(join(dir, file)).text()

    return presets.some(contents => contents.get(file) === text) ? undefined : file
  }))

  return own.filter(file => file !== undefined)
}

const LINTED = /\.(?:kay|[cm]?[jt]sx?)$/

// What `kay check` reports of the project, kay.config.ts read as it reads it: a warning fails the `check` script a scaffold writes.
async function checked(dir: string) {
  return check(dir, configCheckOptions(await loadConfig(dir)))
}

// What `prepack` emits, the declarations and the ESLint processor, made once for every scaffold of the run, as it is the same for each.
let packed: Promise<string> | undefined

async function pack(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'kay-packed-'))
  // Not type-checked again: `bun run check` covers kay's source, and the declarations come out the same.
  const emit = Bun.spawn([nativeExe(), '-p', join(repo, 'tsconfig.build.json'), '--outDir', join(dir, 'types'), '--noCheck'], { stdout: 'pipe', stderr: 'pipe' })

  expect(await emit.exited).toBe(0)

  const processor = await Bun.build({ entrypoints: [join(repo, 'src/eslint/index.ts')], target: 'node', packages: 'external', outdir: join(dir, 'dist'), naming: 'eslint.js' })

  expect(processor.success).toBe(true)

  return dir
}

// The files of the app preset, with postgres or without, as scaffolded under the name my-app.
async function createProjectFiles(variant: 'app' | 'postgres'): Promise<Record<string, string>> {
  const dir = join(await mkdtemp(join(tmpdir(), 'kay-new-')), 'my-app')

  try {
    const files = await createProject(dir, { kay: '^1.0.0', features: variant === 'app' ? PRESETS.app.features : [...PRESETS.app.features, 'postgres'] })

    return Object.fromEntries(await Promise.all(files.map(async file => [file, await Bun.file(join(dir, file)).text()] as const)))
  }
  finally {
    await rm(join(dir, '..'), { recursive: true, force: true })
  }
}

// The default server preset, scaffolded and installed once: `kay new` checks it as written, then `kay build --compile` adds pages of its own and builds it.
let serverPreset: Promise<{ dir: string, files: string[] }> | undefined

async function scaffoldServerPreset(): Promise<{ dir: string, files: string[] }> {
  serverPreset ??= (async () => {
    const dir = join(await mkdtemp(join(tmpdir(), 'kay-new-')), 'my-app')
    const files = await createProject(dir, { kay: '^1.0.0' })

    await installKay(dir)

    return { dir, files }
  })()

  return serverPreset
}

afterAll(async () => {
  if (packed)
    await rm(await packed, { recursive: true, force: true })

  if (serverPreset)
    await rm(join((await serverPreset).dir, '..'), { recursive: true, force: true })
})

const LIBRARIES = ['kayjs-auth', 'kayjs-ui']

// Stands in for `bun install` of a packed kay: its source and what `prepack` emits, copied rather than linked so they resolve from the project, beside this checkout's dependencies.
async function installKay(dir: string) {
  const modules = join(dir, 'node_modules')
  const kay = join(modules, 'kay')

  packed ??= pack()
  await mkdir(kay, { recursive: true })
  await Promise.all([
    // The checkout's own `kay` is a link back to it, which the packed copy below replaces.
    ...(await readdir(join(repo, 'node_modules'))).filter(name => name !== 'kay' && name !== '.bin').map(async name => symlink(join(repo, 'node_modules', name), join(modules, name))),
    ...['package.json', 'src'].map(async name => symlink(join(repo, name), join(kay, name))),
  ])
  await cp(await packed, kay, { recursive: true })
  // The `kay` an install links into `.bin`, which the scripts of the scaffold run.
  await mkdir(join(modules, '.bin'), { recursive: true })
  await Promise.all((await readdir(join(repo, 'node_modules/.bin'))).filter(name => name !== 'kay').map(async name => symlink(join(repo, 'node_modules/.bin', name), join(modules, '.bin', name))))
  await Bun.write(join(modules, '.bin', 'kay'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(repo, 'src/cli.ts'))} "$@"\n`)
  await chmod(join(modules, '.bin', 'kay'), 0o755)
  // kayjs-auth and kayjs-ui resolve `kay` from where they sit, so copies of the workspace's own go beside the project's kay: linked, they would type-check against the checkout's.
  if (await Bun.file(join(dir, 'src/auth.ts')).exists()) {
    const scope = join(modules, '@kaynooo')

    await rm(scope, { force: true })
    await mkdir(scope)
    await Promise.all([
      ...(await readdir(join(repo, 'node_modules/@kaynooo'))).filter(name => !LIBRARIES.includes(name)).map(async name => symlink(join(repo, 'node_modules/@kaynooo', name), join(scope, name))),
      ...LIBRARIES.map(async name => cp(join(repo, 'node_modules/@kaynooo', name), join(scope, name), { recursive: true, dereference: true, filter: source => basename(source) !== 'node_modules' })),
    ])
  }
}

// Each feature alone, and the app with each one left out, or put in where the app lacks it.
const VARIANTS = FEATURE_NAMES.flatMap(feature => [[`${feature} alone`, toggle(new Set(), feature)], [PRESETS.app.features.includes(feature) ? `the app without ${feature}` : `the app with ${feature}`, toggle(new Set(PRESETS.app.features), feature)]] as const)
// Installed and type-checked besides the four presets, each linted and tested on the files it generates differently from every preset (`ownFiles`): the app without auth writes none, so it is only checked. With them, server runs with auth and ws (app), with ws alone (the app without auth) and with neither (server); starter and tailwind each run with accents (server) and without (the app without tailwind, the app without starter); server, starter and tailwind each run absent, and the tests of a project with neither a server nor the starter pages run in eslint and tests alone. ci and docker write only text files.
const INSTALLED: [string, ReadonlySet<Feature>][] = [
  ['the app without starter', toggle(new Set(PRESETS.app.features), 'starter')],
  ['the app without tailwind', toggle(new Set(PRESETS.app.features), 'tailwind')],
  ['the app without auth', toggle(new Set(PRESETS.app.features), 'auth')],
  ['eslint and tests alone', new Set(['eslint', 'tests'])],
]

// What a file names in an import, a side-effect or dynamic one, or a CSS @import.
const SPECIFIER = /\b(?:from|import)\s*(?:\(\s*)?(['"])([^'"\n]+)\1/g
const ICON_SET = /^~icons\/([^/]+)\//
// A script run as `bun run <name>` in a workflow, the Dockerfile, AGENTS.md or a comment, or as compose's `[bun, run, <name>]`.
const SCRIPT_RUN = /\bbun,? run,? ([\w:-]+)/g
const DOCKER_COPY = /^COPY (?!--from)(.+) \S+$/gm
const MIGRATIONS = /migrationsDir: '([^']+)'/g
// The package each command a script runs comes from, Bun aside.
const SCRIPT_BINS: Record<string, string | undefined> = { 'bun': undefined, 'kay': 'kay', 'keslint': '@kaynooo/eslint', 'pg-orm': '@kaynooo/pg-orm' }
// Declared though nothing imports them: Bun's types, and Elysia, which kay needs beside it.
const UNIMPORTED = new Set(['@types/bun', 'elysia', '@iconify-json/tabler'])

// What a scaffold's files name that it lacks: a relative import, preload, extended tsconfig, copied file or migrations folder, a package it imports without depending on it, a script package.json does not hold; and a dependency nothing imports.
function unresolved(files: Record<string, string>): { paths: string[], undeclared: string[], unused: string[], scripts: string[] } {
  const manifest = JSON.parse(files['package.json']!) as { scripts: Record<string, string>, dependencies: Record<string, string>, devDependencies: Record<string, string> }
  const paths: string[] = []
  const packages = new Set<string>()
  const scripts = new Set<string>()
  const name = (from: string, specifier: string) => {
    if (specifier.startsWith('.')) {
      const path = posix.join(posix.dirname(from), specifier)

      if (![path, `${path}.ts`, `${path}.kay`, `${path}/index.ts`].some(candidate => candidate in files))
        paths.push(`${from}: ${specifier}`)
    }
    else if (!specifier.startsWith('node:') && !specifier.startsWith('bun:')) {
      const icons = ICON_SET.exec(specifier)

      packages.add(icons ? `@iconify-json/${icons[1]}` : specifier.split('/').slice(0, specifier.startsWith('@') ? 2 : 1).join('/'))
    }
  }

  for (const [script, command] of Object.entries(manifest.scripts)) {
    const space = command.indexOf(' ')
    const bin = space === -1 ? command : command.slice(0, space)

    if (!(bin in SCRIPT_BINS))
      scripts.add(`package.json: ${script} runs ${bin}`)
    else if (SCRIPT_BINS[bin] !== undefined)
      packages.add(SCRIPT_BINS[bin])
  }

  for (const [file, content] of Object.entries(files)) {
    if ((/\.(?:ts|kay|css)$/).test(file)) {
      for (const [, , specifier] of content.matchAll(SPECIFIER))
        name(file, specifier!)
    }

    for (const [, script] of content.matchAll(SCRIPT_RUN)) {
      if (!Object.hasOwn(manifest.scripts, script!))
        scripts.add(`${file}: ${script}`)
    }

    for (const [, folder] of content.matchAll(MIGRATIONS)) {
      if (!Object.keys(files).some(other => other.startsWith(`${folder}/`)))
        paths.push(`${file}: ${folder}`)
    }
  }

  for (const preload of (files['bunfig.toml'] === undefined ? [] : (Bun.TOML.parse(files['bunfig.toml']) as { test: { preload: string[] } }).test.preload))
    name('bunfig.toml', preload)

  name('tsconfig.json', (JSON.parse(files['tsconfig.json']!) as { extends: string }).extends)

  for (const [, sources] of (files.Dockerfile ?? '').matchAll(DOCKER_COPY)) {
    for (const source of sources!.split(' ').filter(source => source !== '.' && !source.includes('*'))) {
      if (!(source in files))
        paths.push(`Dockerfile: ${source}`)
    }
  }

  const declared = [...Object.keys(manifest.dependencies), ...Object.keys(manifest.devDependencies)]

  return {
    paths,
    undeclared: [...packages].filter(used => !declared.includes(used)),
    unused: declared.filter(dependency => !packages.has(dependency) && !UNIMPORTED.has(dependency)),
    scripts: [...scripts],
  }
}

// Lints as `bun run lint` does, through `kay lint` and the keslint it runs under Node, as JSON.
async function lint(dir: string, path: string): Promise<{ filePath: string, messages: { ruleId: string | null, line: number }[] }[]> {
  const { stdout, stderr } = await kay(['lint', '--format', 'json', path], dir)

  expect(stderr).toBe('')

  return JSON.parse(stdout) as { filePath: string, messages: { ruleId: string | null, line: number }[] }[]
}

async function kay(args: string[], cwd?: string): Promise<{ stdout: string, stderr: string, code: number }> {
  const child = Bun.spawn([process.execPath, join(repo, 'src/cli.ts'), ...args], { cwd: cwd ?? process.cwd(), stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])

  return { stdout, stderr, code }
}

const COMMANDS = {
  build: async () => (await import('../src/commands/build')).build,
  check: async () => (await import('../src/commands/check')).check,
  dev: async () => (await import('../src/commands/dev')).dev,
  fmt: async () => (await import('../src/commands/fmt')).fmt,
  lsp: async () => (await import('../src/commands/lsp')).lsp,
  new: async () => (await import('../src/commands/new')).scaffold,
}

// What `kay <name> <args>` prints and answers, through `runCommand` as the CLI runs it, for a command that stops at its usage or a refusal.
async function inProcess(name: keyof typeof COMMANDS, args: string[]): Promise<{ stdout: string, stderr: string, code: number }> {
  const out: string[] = []
  const err: string[] = []
  const log = spyOn(console, 'log').mockImplementation((...parts: unknown[]) => void out.push(parts.join(' ')))
  const error = spyOn(console, 'error').mockImplementation((...parts: unknown[]) => void err.push(parts.join(' ')))

  try {
    const code = await runCommand(await COMMANDS[name](), args, `Usage: kay ${USAGES[name]}`)

    return { stdout: out.map(line => `${line}\n`).join(''), stderr: err.map(line => `${line}\n`).join(''), code }
  }
  finally {
    log.mockRestore()
    error.mockRestore()
  }
}

// One after the other, as they share the console they capture.
async function inEach(runs: string[][]): Promise<{ args: string[], stdout: string, stderr: string, code: number }[]> {
  const results = []

  for (const args of runs)
    results.push({ args, ...await inProcess(args[0] as keyof typeof COMMANDS, args.slice(1)) })

  return results
}

describe('kay command line', () => {
  it('prints the usage for --help and -h on every command, without running it', async () => {
    // The bare flags go through the CLI's own entry, the rest through the command they follow.
    const runs = [...await Promise.all([['--help'], ['-h']].map(async args => ({ args, ...await kay(args) }))), ...await inEach([['build', '--help'], ['check', '-h'], ['new', '--help'], ['fmt', '--help'], ['dev', '--help'], ['lsp', '--help']])]

    for (const { args, stdout, stderr, code } of runs)
      expect({ args, stdout: stdout.startsWith(`Usage: kay ${args[0] === '--help' || args[0] === '-h' ? 'new' : args[0]}`), stderr, code }).toEqual({ args, stdout: true, stderr: '', code: 0 })

    expect(runs.find(run => run.args[0] === '--help')!.stdout).toContain('kay lsp --stdio')
    expect(runs.find(run => run.args[0] === 'build')!.stdout.trimEnd().split('\n')).toHaveLength(1)
  })

  it('refuses an option or an argument a command does not take, with the usage', async () => {
    // Refused while the arguments are read, before the command runs: nothing is written.
    const runs = await inEach([['new', '--bogus', 'app'], ['fmt', '--bogus'], ['build', '--bogus'], ['check', '--bogus'], ['dev', '--bogus'], ['build', 'a', 'b'], ['check', '-p'], ['new', 'a', 'b']])

    for (const { args, stdout, stderr, code } of runs)
      expect({ args, stdout, usage: stderr.includes(`Usage: kay ${args[0]}`), code }).toEqual({ args, stdout: '', usage: true, code: 1 })
  })

  it('refuses kay lint in a project with no keslint, writing nothing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kay-cli-'))

    try {
      expect(await kay(['lint', '--fix'], dir)).toEqual({ stdout: '', stderr: 'kay lint: the project has no `keslint`: add `@kaynooo/eslint`\n', code: 1 })
      expect(await readdir(dir)).toEqual([])
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('runs the keslint a workspace root hoists, found from a project nested under it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kay-cli-'))
    const project = join(root, 'apps', 'site')

    try {
      await mkdir(join(root, 'node_modules/.bin'), { recursive: true })
      await mkdir(project, { recursive: true })
      await Bun.write(join(root, 'node_modules/.bin/keslint'), '#!/bin/sh\necho "keslint $@"\n')
      await chmod(join(root, 'node_modules/.bin/keslint'), 0o755)
      expect(await kay(['lint', '--fix'], project)).toEqual({ stdout: 'keslint --fix\n', stderr: '', code: 0 })
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('writes a GitHub Actions workflow with annotations for --host github, and none for Forgejo', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kay-new-'))

    try {
      const app = await createProject(join(root, 'app'), { kay: '^1.0.0', features: [...PRESETS.app.features, 'postgres'], host: 'github' })
      const site = await createProject(join(root, 'site'), { kay: '^1.0.0', features: PRESETS.site.features, host: 'github' })

      expect(app).toContain('.github/workflows/test.yml')
      expect(site).toContain('.github/workflows/pages.yml')
      expect([...app, ...site].filter(file => file.startsWith('.forgejo'))).toEqual([])

      const test = await Bun.file(join(root, 'app/.github/workflows/test.yml')).text()
      const pages = await Bun.file(join(root, 'site/.github/workflows/pages.yml')).text()

      expect(test).toContain('runs-on: ubuntu-latest')
      expect(test).toContain('uses: oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6 # v2.2.0')
      expect(test).toContain('\npermissions:\n  contents: read\n')
      expect(test).toContain('run: bun run check --format github')
      expect(test).toContain('- 5432:5432')
      expect(test).toContain('DATABASE_URL: postgres://app:app@localhost:5432/app_test')
      expect(test).not.toContain('apt-get')
      expect(pages).toContain('uses: actions/deploy-pages@d6db90164ac5ed86f2b6aed7e0febac5b3c0c03e # v4.0.5')
      expect(pages).toContain('\npermissions:\n  contents: read\n  pages: write\n  id-token: write\n')
      expect(pages).toContain('SITE_BASE: /${{ github.event.repository.name }}')
      expect(pages).not.toContain('gitea-pages')

      // Each is a workflow GitHub reads: a mapping with its jobs.
      for (const text of [test, pages])
        expect(Object.keys((Bun.YAML.parse(text) as { jobs: object }).jobs)).toHaveLength(1)

      expect(await createProject(join(root, 'plain'), { kay: '^1.0.0', features: PRESETS.server.features })).toContain('.forgejo/workflows/test.yml')
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('runs the CI on the runner --runner names, the host\'s own image otherwise, and keeps --host working as --forge with a warning', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kay-new-'))

    try {
      await createProject(join(root, 'forgejo'), { kay: '^1.0.0', features: PRESETS.server.features, runner: 'docker' })
      await createProject(join(root, 'site'), { kay: '^1.0.0', features: PRESETS.site.features, runner: 'self-hosted:amd64' })
      await createProject(join(root, 'github'), { kay: '^1.0.0', features: PRESETS.site.features, host: 'github', runner: 'big' })
      await createProject(join(root, 'plain'), { kay: '^1.0.0', features: PRESETS.server.features })

      expect(await Bun.file(join(root, 'forgejo/.forgejo/workflows/test.yml')).text()).toContain('runs-on: docker\n')
      expect(await Bun.file(join(root, 'site/.forgejo/workflows/pages.yml')).text()).toContain('runs-on: self-hosted:amd64')
      expect(await Bun.file(join(root, 'github/.github/workflows/pages.yml')).text()).toContain('runs-on: big')
      expect(await Bun.file(join(root, 'plain/.forgejo/workflows/test.yml')).text()).toContain('runs-on: debian\n')
      await expect(createProject(join(root, 'bad'), { kay: '^1.0.0', runner: 'a b\nc' })).rejects.toThrow('kay new: --runner is "a b\\nc"')

      const old = await kay(['new', 'old', '--kay', '^1.0.0', '--template', 'server', '--host', 'github', '--runner', 'mine'], root)

      expect(old).toMatchObject({ code: 0, stderr: expect.stringContaining('--host is now --forge') })

      const quiet = await kay(['new', 'quiet', '--kay', '^1.0.0', '--template', 'server', '--host', 'github', '--quiet'], root)

      expect(quiet).toMatchObject({ code: 0, stderr: '' })
      expect(await Bun.file(join(root, 'old/.github/workflows/test.yml')).text()).toContain('runs-on: mine')

      const renamed = await kay(['new', 'renamed', '--kay', '^1.0.0', '--template', 'server', '--forge', 'github', '--quiet'], root)

      expect(renamed.stderr).toBe('')
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('takes the host from the origin remote of the target or the directory it lands in, GitHub only for github.com', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kay-host-'))
    const remote = async (url: string, name: string) => {
      const dir = join(root, name)

      await mkdir(dir, { recursive: true })
      expect(await Bun.spawn(['git', 'init', '-q', dir]).exited).toBe(0)
      expect(await Bun.spawn(['git', '-C', dir, 'remote', 'add', 'origin', url]).exited).toBe(0)

      return dir
    }

    try {
      expect(await detectHost(join(await remote('git@github.com:me/site.git', 'ssh'), 'not', 'yet'))).toBe('github')
      expect(await detectHost(await remote('https://github.com/me/site', 'https'))).toBe('github')
      expect(await detectHost(await remote('git@git.example.com:me/github.com.git', 'other'))).toBe('forgejo')
      expect(await detectHost(join(root, 'no-remote'))).toBe('forgejo')
      expect(await kay(['new', 'app', '--host', 'gitlab'], root)).toMatchObject({ stdout: '', stderr: expect.stringContaining('kay new: --host is gitlab, which is none of forgejo, github\n'), code: 1 })
      expect(await kay(['new', 'app', '--forge', 'gitlab'], root)).toEqual({ stdout: '', stderr: 'kay new: --forge is gitlab, which is none of forgejo, github\n', code: 1 })
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('refuses a missing or non-.kay path of kay fmt, without a stack and without touching the file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kay-cli-'))

    try {
      await Bun.write(join(dir, 'notes.txt'), 'ul\n    li One\n')

      expect(await kay(['fmt', 'notes.txt'], dir)).toEqual({ stdout: '', stderr: 'kay fmt: notes.txt is not a .kay file\n', code: 1 })
      expect(await kay(['fmt', 'nope.kay'], dir)).toEqual({ stdout: '', stderr: 'kay fmt: nope.kay does not exist\n', code: 1 })
      expect(await Bun.file(join(dir, 'notes.txt')).text()).toBe('ul\n    li One\n')
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('scaffolds a directory name holding spaces and braces as a valid package, a literal title and a quoted cd line', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kay-cli-'))

    try {
      const { stdout, code } = await kay(['new', 'my app {x}', '--kay', '^1.0.0'], dir)
      const manifest = await Bun.file(join(dir, 'my app {x}/package.json')).json() as { name: string }

      expect(code).toBe(0)
      expect(manifest.name).toBe('my-app-x')
      expect(await Bun.file(join(dir, 'my app {x}/src/components/header.kay')).text()).toContain('(href="/") my-app-x\n')
      expect(await Bun.file(join(dir, 'my app {x}/kay.config.ts')).text()).toContain('seo: { name: \'my-app-x\', titleTemplate: \'%s | my-app-x\'')
      expect(stdout).toContain('cd \'my app {x}\' && bun install')
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('scaffolds a preset as --with and --without change it, refusing a feature it does not know or one without what it needs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kay-cli-'))

    try {
      expect((await kay(['new', 'styled', '--kay', '^1.0.0', '--template', 'blank', '--with', 'tailwind, tests'], dir)).code).toBe(0)
      expect((await readdir(join(dir, 'styled'), { recursive: true })).sort()).toEqual(['.gitignore', '.npmrc', '.vscode', '.vscode/settings.json', 'AGENTS.md', 'bunfig.toml', 'kay.config.ts', 'package.json', 'src', 'src/app.css', 'src/routes', 'src/routes/_layout.kay', 'src/routes/index.kay', 'tests', 'tests/home.test.ts', 'tsconfig.json'])
      expect((await kay(['new', 'lean', '--kay', '^1.0.0', '--without', 'docker,ci'], dir)).code).toBe(0)
      expect(await readdir(join(dir, 'lean'))).not.toEqual(expect.arrayContaining(['Dockerfile']))
      expect(await Bun.file(join(dir, 'lean/src/server.ts')).exists()).toBe(true)
      expect(await kay(['new', 'unknown', '--with', 'bogus'], dir)).toEqual({ stdout: '', stderr: 'kay new: bogus is none of the features server, starter, tailwind, accents, eslint, tests, ci, docker, auth, postgres, ws\n', code: 1 })
      expect(await kay(['new', 'both', '--with', 'docker', '--without', 'ci,docker'], dir)).toEqual({ stdout: '', stderr: 'kay new: docker is in both --with and --without\n', code: 1 })
      expect(await kay(['new', 'static', '--kay', '^1.0.0', '--template', 'site', '--with', 'auth'], dir)).toEqual({ stdout: '', stderr: 'kay: auth needs server: add --with server, or drop it with --without auth\n', code: 1 })
      expect(await kay(['new', 'unstyled', '--kay', '^1.0.0', '--without', 'tailwind'], dir)).toEqual({ stdout: '', stderr: 'kay: accents needs tailwind: add --with tailwind, or drop it with --without accents\n', code: 1 })
      expect((await readdir(dir)).sort()).toEqual(['lean', 'styled'])
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('asks in a terminal for a preset, then for its features one by one, and scaffolds what was checked', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kay-cli-'))
    let screen = ''
    const terminal = new Bun.Terminal({ cols: 120, data: (_terminal, data) => void (screen += new TextDecoder().decode(data)) })

    try {
      const child = Bun.spawn([process.execPath, join(repo, 'src/cli.ts'), 'new', 'picked', '--kay', '^1.0.0'], { cwd: dir, terminal })

      await shown(() => screen, 'Start from')
      // From the server preset up to blank, then server checked, and the accent picker with the starter pages and Tailwind it needs.
      terminal.write('\x1B[A\r')
      await shown(() => screen, 'Features')
      // Home and Ctrl+Down, which the picker does not read, leave it open.
      terminal.write('\x1B[H\x1B[1;5B \x1B[B\x1B[B\x1B[B \r')

      expect(await child.exited).toBe(0)
      expect(screen).toContain('Start from \x1B[36mblank')
      expect(screen).toContain('Features \x1B[36mserver, starter, tailwind, accents\x1B')

      const files = await readdir(join(dir, 'picked'), { recursive: true })

      expect(files).toEqual(expect.arrayContaining(['src/server.ts', 'src/app.css', 'src/components/accent-picker.kay', 'src/components/header.kay']))
      expect(files).not.toEqual(expect.arrayContaining(['eslint.config.ts']))
      expect(files).not.toEqual(expect.arrayContaining(['bunfig.toml']))
    }
    finally {
      terminal.close()
      await rm(dir, { recursive: true, force: true })
    }
  }, 15_000)

  it('writes nothing once the terminal prompt is cancelled', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kay-cli-'))
    let screen = ''
    const terminal = new Bun.Terminal({ data: (_terminal, data) => void (screen += new TextDecoder().decode(data)) })

    try {
      const child = Bun.spawn([process.execPath, join(repo, 'src/cli.ts'), 'new', 'dropped', '--kay', '^1.0.0'], { cwd: dir, terminal })

      await shown(() => screen, 'Start from')
      terminal.write('\x03')

      expect(await child.exited).toBe(1)
      await shown(() => screen, 'kay new: cancelled, nothing written')
      expect(await readdir(dir)).toEqual([])
    }
    finally {
      terminal.close()
      await rm(dir, { recursive: true, force: true })
    }
  }, 15_000)

  it('refuses to scaffold over a file or into a directory that already holds files, with a message and touching neither', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kay-cli-'))

    try {
      await Promise.all([Bun.write(join(dir, 'afile'), 'x'), Bun.write(join(dir, 'full/keep.txt'), 'mine')])

      expect(await Promise.all([kay(['new', 'afile'], dir), kay(['new', 'full'], dir)])).toEqual([
        { stdout: '', stderr: 'kay: afile is not a directory\n', code: 1 },
        { stdout: '', stderr: 'kay: full is not empty\n', code: 1 },
      ])
      expect(await Bun.file(join(dir, 'afile')).text()).toBe('x')
      expect(await readdir(join(dir, 'full'))).toEqual(['keep.txt'])
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('kay new', () => {
  it('scaffolds a project that type-checks against the declarations of kay, is formatted and builds as it is', async () => {
    const { dir, files } = await scaffoldServerPreset()
    const manifest = await Bun.file(join(dir, 'package.json')).json() as { dependencies: Record<string, string>, devDependencies: Record<string, string>, scripts: Record<string, string> }

    expect(files).toContain('src/routes/index.kay')
    // The container runs the one executable `kay build --compile` makes.
    expect(files).toEqual(expect.arrayContaining(['Dockerfile', 'compose.prod.yaml', 'src/components/accent-picker.kay']))
    expect(manifest.scripts.compile).toBe('kay build --compile server')
    // A warning is shown, and fails CI only where the app adds `--deny-warnings`.
    expect(manifest.scripts.check).toBe('kay check')
    expect(manifest.scripts.lint).toBe('kay lint --cache')
    expect(await Bun.file(join(dir, '.vscode/settings.json')).json()).toEqual({ 'eslint.validate': ['javascript', 'javascriptreact', 'typescript', 'typescriptreact', 'kay'], 'tailwindCSS.includeLanguages': { kay: 'html' }, 'tailwindCSS.experimental.classRegex': TAILWIND_CLASS_REGEX })
    expect(await Bun.file(join(dir, 'AGENTS.md')).text()).toContain('run `bun run check`, `bun run fmt`, `bun run lint`, and `bun run test`.')
    expect(await Bun.file(join(dir, 'Dockerfile')).text()).toContain('RUN bun run compile')
    expect(await Bun.file(join(dir, 'Dockerfile')).text()).toContain('HEALTHCHECK --interval=30s --timeout=6s CMD ["./server", "--health"]')
    expect(Object.keys(manifest.devDependencies)).toEqual(['@iconify-json/tabler', '@kaynooo/eslint', '@types/bun', 'bun-plugin-tailwind', 'tailwindcss'])
    expect(await Bun.file(join(dir, '.npmrc')).text()).toBe('@kaynooo:registry=https://git.kaynooo.fr/api/packages/kaynooo/npm/\n')
    expect(manifest.dependencies.kay).toBe('^1.0.0')
    expect(await Bun.file(join(dir, 'src/components/header.kay')).text()).toContain('(href="/") my-app\n')
    // As strict as kay itself, and checked, linted and tested on every push.
    expect(await Bun.file(join(dir, 'tsconfig.json')).json()).toEqual({ extends: 'kay/tsconfig.json' })
    expect(((await Bun.file(join(repo, 'src/tsconfig.app.json')).json()) as { compilerOptions: Record<string, unknown> }).compilerOptions).toMatchObject({ strict: true, exactOptionalPropertyTypes: true, noFallthroughCasesInSwitch: true, noImplicitOverride: true, noUncheckedIndexedAccess: true })
    expect(await Bun.file(join(dir, '.forgejo/workflows/test.yml')).text()).toContain('run: bun run check --format github\n\n      - name: Lint\n        run: bun run lint\n\n      - name: Test\n        run: bun run test\n')

    // Stricter than kay itself: its source fails this flag, its declarations must not.
    const scaffolded = await Bun.file(join(dir, 'tsconfig.json')).text()
    const tsconfig = JSON.parse(scaffolded) as { compilerOptions: Record<string, unknown> }

    await Bun.write(join(dir, 'tsconfig.json'), JSON.stringify({ ...tsconfig, compilerOptions: { ...tsconfig.compilerOptions, exactOptionalPropertyTypes: true } }))

    // The scaffolded tsconfig comes back whatever the check finds, as lint and the compile test after this one read it.
    try {
      expect(await checked(dir)).toEqual([])
    }
    finally {
      await Bun.write(join(dir, 'tsconfig.json'), scaffolded)
    }

    expect((await formatFiles([join(dir, 'src')], { write: false })).changed).toEqual([])

    // What this test adds to the scaffold the compile test shares is removed whatever its asserts find.
    try {
      // A page's server fence is linted with the project's types, at its .kay line, and it is the only message of the whole project.
      await Bun.write(join(dir, 'src/routes/later.kay'), '--- server\nBun.write(\'later.txt\', \'later\')\n---\np Later\n')
      expect(await checked(dir)).toEqual([])
      expect((await lintInProcess(dir, '.')).filter(result => result.messages.length > 0).map(result => ({ file: relative(dir, result.filePath), messages: result.messages }))).toEqual([{ file: 'src/routes/later.kay', messages: [expect.objectContaining({ ruleId: 'ts/no-floating-promises', line: 2 })] }])

      // The accent picker as a visitor meets it: rendered from the cookie, a value it does not know read as the default, and changed by a click.
      await Bun.write(join(dir, 'tests/accent.test.ts'), ACCENT_TEST.replace('__WIRE__', JSON.stringify(join(repo, 'src/runtime/wire'))))

      const tests = Bun.spawn([process.execPath, 'test'], { cwd: dir, stdout: 'pipe', stderr: 'pipe' })
      const [report, code] = await Promise.all([new Response(tests.stderr).text(), tests.exited])

      expect(report).toContain('3 pass')
      expect(code).toBe(0)

      const client = await buildClient(dir)

      // In the order the bundler wrote their chunks, not the source's.
      expect(Object.keys(client.islands).sort()).toEqual(['src/components/accent-picker.kay', 'src/components/counter.kay'])
      const stylesheet = client.styles.get(join(dir, 'src/routes/_layout.kay'))!

      expect(await Bun.file(join(client.dir, stylesheet.slice('/_kay/'.length))).text()).toMatch(/@media \(prefers-reduced-motion: ?no-preference\) ?\{\s*@view-transition/)
    }
    finally {
      await Promise.all([rm(join(dir, 'src/routes/later.kay'), { force: true }), rm(join(dir, 'tests/accent.test.ts'), { force: true }), rm(clientDir(dir), { recursive: true, force: true })])
    }
  }, SCAFFOLD_MS)

  it('scaffolds a static site that type-checks and exports to dist, with a Pages workflow and a container beside it', async () => {
    const dir = join(await mkdtemp(join(tmpdir(), 'kay-new-')), 'my-site')

    try {
      const files = await createProject(dir, { kay: '^1.0.0', features: PRESETS.site.features })
      const manifest = await Bun.file(join(dir, 'package.json')).json() as { scripts: Record<string, string> }

      expect(files).toContain('.forgejo/workflows/pages.yml')
      expect(files).toContain('Dockerfile')
      expect(files).not.toContain('src/server.ts')
      expect(manifest.scripts.build).toBe('kay build --static')
      expect(manifest.scripts.test).toBe('kay test')
      expect(await Bun.file(join(dir, '.forgejo/workflows/pages.yml')).text()).toContain('SITE_BASE: /${{ github.repository }}')
      expect(await Bun.file(join(dir, '.forgejo/workflows/pages.yml')).text()).toContain('uses: peaceiris/actions-gh-pages@373f7f263a76c20808c831209c920827a82a2847 # v3.9.3')
      // Tested before it builds, which checks it, and linted after.
      expect(await Bun.file(join(dir, '.forgejo/workflows/pages.yml')).text()).toMatch(/run: bun run test\n\n {6}- name: Build the site\n/)
      expect(await Bun.file(join(dir, '.forgejo/workflows/pages.yml')).text()).toMatch(/run: bun run build\n\n {6}- name: Lint\n {8}run: bun run lint\n/)

      await installKay(dir)
      // Linted before any check or dev run wrote the types its rules read.
      expect((await lint(dir, '.')).flatMap(result => result.messages)).toEqual([])
      expect(await checked(dir)).toEqual([])

      // With no server entry, `kay dev` serves the pages with kay's own, live reload included.
      const server = Bun.spawn([process.execPath, join(import.meta.dir, '../src/cli.ts'), 'dev'], { cwd: dir, env: { ...process.env, PORT: '0' }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })

      try {
        const home = await (await fetch(`http://localhost:${await listeningPort(server, 'the executable', LISTENING)}/`)).text()

        expect(home).toContain('<title>Home | my-site</title>')
        expect(home).toContain('new EventSource("/_kay/dev/events")')
      }
      finally {
        server.kill()
        await server.exited
      }

      const build = Bun.spawn([process.execPath, join(import.meta.dir, '../src/cli.ts'), 'build', '--static'], { cwd: dir, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, SITE_URL: 'https://pages.example', SITE_BASE: '/me/my-site' } })
      const [report, code] = await Promise.all([new Response(build.stdout).text(), build.exited])

      expect(report).toContain('exported 1 page')
      expect(code).toBe(0)
      const html = await Bun.file(join(dir, 'dist/index.html')).text()
      // The scaffold's stylesheet is small, so the page carries it.
      const stylesheet = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map(match => match[1]).join('')

      expect(html).toContain('<link rel="canonical" href="https://pages.example/me/my-site/">')
      expect(html).toContain('<title>Home | my-site</title>')
      expect(html).toContain('<a class="skip-link" href="#main-content">')
      expect(html).toContain('<style>:root { --accent: var(--accent-peach); }</style>')
      // Every accent the picker offers, though only the picker reads them.
      expect(stylesheet.match(/--accent-[a-z]+:#/g)).toHaveLength(14)
      expect(stylesheet).toContain('.text-accent')
      expect(await Bun.file(join(dir, 'dist/404.html')).exists()).toBe(true)
    }
    finally {
      await rm(join(dir, '..'), { recursive: true, force: true })
    }
  }, SCAFFOLD_MS)

  it('scaffolds an app on kayjs-auth with its users in a SQLite file, guarded pages and a websocket island, which runs its tests with Bun alone', async () => {
    const dir = join(await mkdtemp(join(tmpdir(), 'kay-new-')), 'my-app')

    try {
      const files = await createProject(dir, { kay: '^1.0.0', features: PRESETS.app.features })

      expect(files).toEqual(expect.arrayContaining(['.env.example', 'src/auth.ts', 'src/routes/_guard.ts', 'src/api/online.ts', 'tests/online.test.ts']))
      expect(files.filter(file => file === 'compose.dev.yaml' || file.startsWith('db/') || file.startsWith('migrations/') || file === 'pg-orm.config.ts' || file.startsWith('src/db/') || file === 'src/session.ts' || file === 'src/routes/login.kay')).toEqual([])
      expect(files).not.toContain('.env')
      expect(files).not.toContain('.env.test')
      expect(await Bun.file(join(dir, '.env.example')).text()).toStartWith('# Each one generated and kept out of the repository: ')
      expect(await Bun.file(join(dir, '.env.example')).text()).toMatch(/\nKAY_SECRET=\nSITE_URL=\n$/)
      expect((await Bun.file(join(dir, '.gitignore')).text()).split('\n')).toContain('data')
      expect((await Bun.file(join(dir, '.dockerignore')).text()).split('\n')).toContain('data')

      const manifest = await Bun.file(join(dir, 'package.json')).json() as { scripts: Record<string, string>, dependencies: Record<string, string> }

      expect(manifest.scripts.dev).toBe('kay dev')
      expect(Object.keys(manifest.scripts).filter(name => name.startsWith('db:'))).toEqual([])
      expect(Object.keys(manifest.dependencies)).toEqual(expect.arrayContaining(['@kaynooo/kayjs-auth', '@kaynooo/kayjs-ui', '@kaynooo/pg-orm']))
      // No Postgres service in CI, and the file lives on a volume the image prepares for the app's user.
      expect(await Bun.file(join(dir, '.forgejo/workflows/test.yml')).text()).not.toContain('postgres')
      expect(await Bun.file(join(dir, 'Dockerfile')).text()).toContain('RUN mkdir data && chown nobody data\n')

      const compose = await Bun.file(join(dir, 'compose.prod.yaml')).text()

      expect(compose).toContain('KAY_SECRET: ${KAY_SECRET:?set KAY_SECRET}')
      expect(compose).toContain('- data:/app/data')
      expect(compose).not.toContain('postgres')

      await installKay(dir)
      expect(await checked(dir)).toEqual([])
      expect(await Bun.file(join(dir, 'kay.config.ts')).text()).toContain('extensions: [authPages({ auth: async () => import(\'./src/auth\') }), ui()],')
      expect(JSON.parse((await kay(['check', dir, '--format', 'json'])).stdout)).toEqual({ errors: 0, warnings: 0, problems: [] })
      expect((await formatFiles([join(dir, 'src')], { write: false })).changed).toEqual([])
      // The server preset's own files are linted by its test.
      expect((await lintInProcess(dir, (await ownFiles(dir, files, ['server'])).filter(file => LINTED.test(file)))).flatMap(result => result.messages)).toEqual([])

      const tests = Bun.spawn([process.execPath, 'run', 'test'], { cwd: dir, stdout: 'pipe', stderr: 'pipe' })
      const [report, output, code] = await Promise.all([new Response(tests.stderr).text(), new Response(tests.stdout).text(), tests.exited])

      expect({ code, passed: report.includes('2 pass'), ...code === 0 && report.includes('2 pass') ? {} : { report, output } }).toEqual({ code: 0, passed: true })
      expect(await Bun.file(join(dir, 'data/auth.db')).exists()).toBe(true)
    }
    finally {
      await rm(join(dir, '..'), { recursive: true, force: true })
    }
  }, SCAFFOLD_MS)

  it('scaffolds an app with kayjs-auth in Postgres behind the postgres feature, which checks and builds as it is and generates its first migration', async () => {
    const dir = join(await mkdtemp(join(tmpdir(), 'kay-new-')), 'my-app')

    try {
      const files = await createProject(dir, { kay: '^1.0.0', features: [...PRESETS.app.features, 'postgres'] })

      expect(files).toEqual(expect.arrayContaining(['.env', '.env.example', '.env.test', 'compose.dev.yaml', 'db/roles.sh', 'migrations/.gitkeep', 'pg-orm.config.ts', 'src/db/index.ts', 'src/auth.ts', 'src/routes/_guard.ts', 'src/api/online.ts', 'tests/online.test.ts']))
      expect((await stat(join(dir, '.env'))).mode & 0o777).toBe(0o600)
      expect(await Bun.file(join(dir, '.env')).text()).toMatch(/^DATABASE_URL=postgres:\/\/app_rw:app_rw@127\.0\.0\.1:5433\/app\nMIGRATE_DATABASE_URL=postgres:\/\/app:app@127\.0\.0\.1:5433\/app\nCOMPOSE_FILE=compose\.dev\.yaml\n$/)

      const manifest = await Bun.file(join(dir, 'package.json')).json() as { scripts: Record<string, string> }

      expect(manifest.scripts).toMatchObject({ 'dev': 'kay dev', 'db:generate': 'pg-orm generate', 'db:migrate': 'pg-orm apply' })
      // Every env file but the example and the tests' own stays out of git, and all of them out of the image; the users are not in a file.
      expect((await Bun.file(join(dir, '.gitignore')).text()).split('\n')).toEqual(expect.arrayContaining(['.env', '.env.*', '!.env.example', '!.env.test']))
      expect((await Bun.file(join(dir, '.gitignore')).text()).split('\n')).not.toContain('data')
      expect((await Bun.file(join(dir, '.dockerignore')).text()).split('\n')).toEqual(expect.arrayContaining(['.git', '.env', '.env.*']))
      expect(await Bun.file(join(dir, 'Dockerfile')).text()).not.toContain('mkdir data')

      const compose = await Bun.file(join(dir, 'compose.prod.yaml')).text()

      expect(compose).toContain('KAY_SECRET: ${KAY_SECRET:?set KAY_SECRET}')
      // Reached through the reverse proxy on this machine alone.
      expect(compose).toContain('- 127.0.0.1:3000:3000')
      expect(compose).not.toContain('- 3000:3000')
      // The app reads and writes rows as app_rw, the migrations change the schema as the owner, and the database image creates app_rw from db/roles.sh.
      expect(compose).toContain('DATABASE_URL: postgres://app_rw:${APP_DB_PASSWORD}@db:5432/app')
      expect(compose).toContain('MIGRATE_DATABASE_URL: postgres://app:${POSTGRES_PASSWORD}@db:5432/app')
      expect(compose).toContain('./db/roles.sh:/docker-entrypoint-initdb.d/roles.sh:ro')
      expect(await Bun.file(join(dir, 'compose.dev.yaml')).text()).toContain('./db/roles.sh:/docker-entrypoint-initdb.d/roles.sh:ro')
      expect(await Bun.file(join(dir, 'db/roles.sh')).text()).toContain('ALTER DEFAULT PRIVILEGES FOR ROLE')
      expect(await Bun.file(join(dir, 'pg-orm.config.ts')).text()).toContain('process.env.MIGRATE_DATABASE_URL ?? process.env.DATABASE_URL')
      expect(await Bun.file(join(dir, 'src/db/index.ts')).text()).toContain('export const tables = [...authTables]')
      expect(await Bun.file(join(dir, 'src/auth.ts')).text()).toContain('store: pgStore(db)')
      // On the Bun that scaffolded it, rather than whatever is latest when it builds.
      expect(await Bun.file(join(dir, 'Dockerfile')).text()).toStartWith(`FROM oven/bun:${Bun.version} AS build\n`)
      expect(await Bun.file(join(dir, '.forgejo/workflows/test.yml')).text()).toContain(`bun-version: ${Bun.version}\n`)
      expect(await Bun.file(join(dir, '.env.example')).text()).toMatch(/\nKAY_SECRET=\nSITE_URL=\nPOSTGRES_PASSWORD=\nAPP_DB_PASSWORD=\n$/)

      await installKay(dir)
      expect(await checked(dir)).toEqual([])
      expect((await formatFiles([join(dir, 'src')], { write: false })).changed).toEqual([])
      // Every preset's own files are linted by theirs.
      expect((await lintInProcess(dir, (await ownFiles(dir, files)).filter(file => LINTED.test(file)))).flatMap(result => result.messages)).toEqual([])

      // The first migration is generated and applied on a Postgres the test user may create databases on, which CI always has: the tests then run on a database per file.
      if ((TEST_DATABASE_URL ?? '') !== '' || (process.env.CI ?? '') !== '') {
        const env = { ...process.env, ...TEST_DATABASE_URL !== undefined && TEST_DATABASE_URL !== '' && { DATABASE_URL: TEST_DATABASE_URL } }
        const generate = Bun.spawn([process.execPath, 'run', 'db:generate', 'init'], { cwd: dir, stdout: 'pipe', stderr: 'pipe', env })

        expect(await generate.exited).toBe(0)

        const tests = Bun.spawn([process.execPath, 'run', 'test'], { cwd: dir, stdout: 'pipe', stderr: 'pipe', env })
        const [report, output, code] = await Promise.all([new Response(tests.stderr).text(), new Response(tests.stdout).text(), tests.exited])

        // A run that passed its tests and still exited 1 failed in CI once with no report to read, so a failure prints both streams.
        expect({ code, passed: report.includes('2 pass'), ...code === 0 && report.includes('2 pass') ? {} : { report, output } }).toEqual({ code: 0, passed: true })
      }

      expect(Object.keys((await buildClient(dir)).islands).toSorted()).toEqual(['src/components/accent-picker.kay', 'src/components/counter.kay', 'src/components/online.kay'])
    }
    finally {
      await rm(join(dir, '..'), { recursive: true, force: true })
    }
  }, SCAFFOLD_MS)

  it('writes the files kayjs-auth\'s own `kay add auth` writes, over a SQLite file of its own and over the project\'s database', async () => {
    const { default: plan } = await import('../packages/auth/src/add')
    const project = (files: Record<string, string>) => ({ name: 'my-app', exists: (path: string) => path in files, read: (path: string) => files[path], depends: (name: string) => name === '@kaynooo/pg-orm' })
    const app = await createProjectFiles('app')
    const pg = await createProjectFiles('postgres')

    for (const [scaffold, files] of [[app, project({})], [pg, project({ 'src/db/index.ts': pg['src/db/index.ts']! })]] as const) {
      const written = plan(files).files

      for (const [path, content] of Object.entries(written))
        expect(scaffold[path]).toBe(content)
    }

    expect(pg['src/db/index.ts']).toContain('...authTables')
  })

  it('scaffolds a blank project of one bare page, which checks and builds as a static site', async () => {
    const dir = join(await mkdtemp(join(tmpdir(), 'kay-new-')), 'my-app')

    try {
      const files = await createProject(dir, { kay: '^1.0.0', features: PRESETS.blank.features })
      const manifest = await Bun.file(join(dir, 'package.json')).json() as { dependencies: Record<string, string>, devDependencies: Record<string, string>, scripts: Record<string, string> }

      expect(files).toEqual(['.gitignore', '.npmrc', 'AGENTS.md', 'kay.config.ts', 'package.json', 'src/routes/_layout.kay', 'src/routes/index.kay', 'tsconfig.json'])
      // kay itself comes from the registry this names, whatever else is left out.
      expect(await Bun.file(join(dir, '.npmrc')).text()).toBe('@kaynooo:registry=https://git.kaynooo.fr/api/packages/kaynooo/npm/\n')
      expect(manifest.scripts).toEqual({ dev: 'kay dev', build: 'kay build --static', check: 'kay check', fmt: 'kay fmt' })
      // An agent reads kay's docs as installed, renames the site every title ends with, and runs the checks this project's scripts hold.
      expect(await Bun.file(join(dir, 'AGENTS.md')).text()).toBe('# my-app\n\nBuilt with kay, a Bun web framework: a `.kay` file is one component, TypeScript fences then a pug-like template. Read kay\'s docs for the installed version before writing kay code; the topic files they link are in `node_modules/kay/llms/`:\n\n@node_modules/kay/llms.txt\n\nEvery page title ends with `seo.name` from `kay.config.ts`, which `kay new` filled in from the folder name: set it to the site\'s real name.\n\nBefore calling a change done, run `bun run check` and `bun run fmt`.\n')
      // Published, so the docs AGENTS.md imports are in node_modules/kay.
      expect(((await Bun.file(join(repo, 'package.json')).json()) as { files: string[] }).files).toEqual(expect.arrayContaining(['llms', 'llms.txt']))
      expect(Object.keys(manifest.devDependencies)).toEqual(['@types/bun'])
      expect(Object.keys(manifest.dependencies)).toEqual(['elysia', 'kay'])

      await installKay(dir)
      expect(await checked(dir)).toEqual([])
      expect((await formatFiles([join(dir, 'src')], { write: false })).changed).toEqual([])

      const build = Bun.spawn([process.execPath, join(repo, 'src/cli.ts'), 'build', '--static'], { cwd: dir, stdout: 'pipe', stderr: 'pipe' })
      const [report, code] = await Promise.all([new Response(build.stdout).text(), build.exited])

      expect(report).toContain('exported 1 page')
      expect(code).toBe(0)
      expect(await Bun.file(join(dir, 'dist/index.html')).text()).toContain('<main><h1>my-app</h1></main>')
      // With no _404.kay, no 404.html: a container's scaffold brings the page its nginx.conf names.
      expect(await Bun.file(join(dir, 'dist/404.html')).exists()).toBe(false)
    }
    finally {
      await rm(join(dir, '..'), { recursive: true, force: true })
    }
  }, 30_000)

  // Without installing, every variant is scaffolded formatted, naming only files it holds, packages it depends on and scripts it has, and depending on nothing it does not import.
  for (const [label, variant] of VARIANTS) {
    it(`scaffolds ${label} formatted, with every file, package and script it names`, async () => {
      const features = [...variant]
      const dir = join(await mkdtemp(join(tmpdir(), 'kay-new-')), 'my-app')

      try {
        const files = await createProject(dir, { kay: '^1.0.0', features })
        const contents = Object.fromEntries(await Promise.all(files.map(async file => [file, await Bun.file(join(dir, file)).text()] as const)))

        expect({ features, ...unresolved(contents) }).toEqual({ features, paths: [], undeclared: [], unused: [], scripts: [] })
        expect({ features, changed: (await formatFiles([join(dir, 'src')], { write: false })).changed }).toEqual({ features, changed: [] })

        // The regex locations must not take `/_kay/`, whose hashed files are immutable.
        if (variant.has('docker') && !variant.has('server'))
          expect({ features, caching: ['location ^~ /_kay/ {', 'woff2?|ttf|otf|eot', 'max-age=2592000', 'max-age=86400'].filter(part => !contents['nginx.conf']!.includes(part)) }).toEqual({ features, caching: [] })

        // The container binds 127.0.0.1 for a reverse proxy, so the visitor's address is read through it.
        if (variant.has('server') && variant.has('docker'))
          expect({ features, proxy: contents['kay.config.ts']!.includes('\n  proxy: true,'), lan: contents['kay.config.ts']!.includes('private-range peers') }).toEqual({ features, proxy: true, lan: true })

        if (variant.has('auth')) {
          const dockerfile = contents.Dockerfile
          const compose = contents['compose.prod.yaml']

          // kayjs-auth keeps its users in a SQLite file under `data` unless Postgres does.
          const file = !variant.has('postgres')

          expect({ features, store: contents['src/auth.ts']!.includes('sqlite://data/auth.db'), ignored: contents['.gitignore']!.split('\n').includes('data') }).toEqual({ features, store: file, ignored: file })

          // The file is written by the user the image runs as, in a folder a volume keeps across deploys.
          if (variant.has('docker')) {
            expect({ features, dir: dockerfile?.includes('RUN mkdir data && chown nobody data\n'), ignored: contents['.dockerignore']!.split('\n').includes('data'), volume: compose?.includes('- data:/app/data') && compose.includes('\nvolumes:\n') && compose.includes('\n  data:') }).toEqual({ features, dir: file, ignored: file, volume: file })
          }
        }

        if (variant.has('docker') && !variant.has('server')) {
          // A static export writes no headers file, so the container's nginx sends HSTS for a site published at https.
          // nginx drops a server-level add_header from a location with its own, so every location setting one repeats it.
          const nginx = contents['nginx.conf']!
          const bare = nginx.match(/location [^{]*\{[^}]*\}/g)!.filter(block => block.includes('add_header') && !block.includes('Strict-Transport-Security'))

          expect({ features, server: nginx.split('\n  add_header Strict-Transport-Security "max-age=31536000" always;').length - 1, bare }).toEqual({ features, server: 1, bare: [] })

          // The export's own headers (CSP and the rest) are included at server level and again wherever a location adds a header of its own.
          const INCLUDE = 'include /etc/nginx/kay-headers.conf;'
          const withoutInclude = nginx.match(/location [^{]*\{[^}]*\}/g)!.filter(block => block.includes('add_header') && !block.includes(INCLUDE))

          expect({ features, server: nginx.split(`\n  ${INCLUDE}`).length - 1, withoutInclude }).toEqual({ features, server: 1, withoutInclude: [] })
          expect({ features, tokens: nginx.includes('\n  server_tokens off;') }).toEqual({ features, tokens: true })

          // The search manifest and the notices keep their name from one build to the next, so they revalidate while the hashed files stay immutable.
          for (const path of [SEARCH_MANIFEST, `${ASSET_PREFIX}${NOTICES_FILE}`]) {
            const block = nginx.match(new RegExp(`location = ${path.replaceAll('.', '\\.')} \\{[^}]*\\}`))?.[0]

            expect({ features, path, noCache: block?.includes('add_header Cache-Control "no-cache";'), headers: block?.includes('Strict-Transport-Security') && block.includes(INCLUDE) }).toEqual({ features, path, noCache: true, headers: true })
          }

          // The stock nginx image cannot send brotli, so the copies are dropped and the include moved out of the served folder.
          const dockerfile = contents.Dockerfile!

          expect({ features, br: dockerfile.includes('-name \'*.br\' -delete'), include: dockerfile.includes('COPY --from=build /app/kay-headers.conf /etc/nginx/kay-headers.conf') }).toEqual({ features, br: true, include: true })
          // The container runs unprivileged: the image that does, on a port above 1024.
          expect({ features, image: (/^FROM nginxinc\/nginx-unprivileged:\d/m).test(dockerfile), port: nginx.includes('listen 8080;') }).toEqual({ features, image: true, port: true })
          // The 404 page the export writes comes from a `_404.kay`, which the starter or the container brings.
          expect({ features, notFound: nginx.includes('error_page 404 /404.html'), page: 'src/routes/_404.kay' in contents }).toEqual({ features, notFound: true, page: true })
        }
      }
      finally {
        await rm(join(dir, '..'), { recursive: true, force: true })
      }
    })
  }

  for (const [label, variant] of INSTALLED) {
    it.concurrent(`scaffolds ${label} as a project that checks, lints and passes its tests`, async () => {
      const features = [...variant]
      const dir = join(await mkdtemp(join(tmpdir(), 'kay-new-')), 'my-app')

      try {
        const own = await ownFiles(dir, await createProject(dir, { kay: '^1.0.0', features }))

        await installKay(dir)
        expect({ features, problems: await checked(dir) }).toEqual({ features, problems: [] })

        const linted = own.filter(file => LINTED.test(file))

        if (variant.has('eslint') && linted.length > 0)
          expect({ features, messages: (await lintInProcess(dir, linted)).flatMap(result => result.messages) }).toEqual({ features, messages: [] })

        if (variant.has('tests') && own.some(file => file.startsWith('src/') || file.startsWith('tests/'))) {
          const tests = Bun.spawn([process.execPath, 'run', 'test'], { cwd: dir, stdout: 'pipe', stderr: 'pipe' })
          const [report, code] = await Promise.all([new Response(tests.stderr).text(), tests.exited])

          expect({ features, code, report }).toEqual({ features, code: 0, report: expect.stringContaining(' 0 fail') })
        }
      }
      finally {
        await rm(join(dir, '..'), { recursive: true, force: true })
      }
    }, SCAFFOLD_MS)
  }

  it('checks what a feature needs along with it, and unchecks what needs it along with it', () => {
    expect([...toggle(new Set(), 'accents')]).toEqual(['accents', 'starter', 'tailwind'])
    expect([...toggle(new Set(PRESETS.app.features), 'server')]).toEqual([...PRESETS.site.features])
    expect([...toggle(new Set(PRESETS.server.features), 'tailwind')]).toEqual(['server', 'starter', 'eslint', 'tests', 'ci', 'docker'])
  })

  it('refuses a feature without what it needs, before writing anything', async () => {
    const dir = join(await mkdtemp(join(tmpdir(), 'kay-new-')), 'my-app')

    try {
      await expect(createProject(dir, { kay: '^1.0.0', features: ['accents'] })).rejects.toThrow('kay: accents needs starter and tailwind: add --with starter,tailwind, or drop it with --without accents')
      expect(await readdir(join(dir, '..'))).toEqual([])
    }
    finally {
      await rm(join(dir, '..'), { recursive: true, force: true })
    }
  })
})

// Waits for a terminal program to print `text`.
async function shown(screen: () => string, text: string): Promise<void> {
  for (let waited = 0; !screen().includes(text); waited += 10) {
    if (waited > 10_000)
      throw new Error(`never shown: ${text}\n${screen()}`)

    await Bun.sleep(10)
  }
}

describe('kay build --compile', () => {
  it('bundles the server, its pages and the client build into one executable that serves them from anywhere', async () => {
    const { dir } = await scaffoldServerPreset()

    await Promise.all(Object.entries({
      'public/robots.txt': 'User-agent: *\n',
      // A static component with relative imports of its own, so its island twin resolves them too.
      'src/components/shout.ts': 'export const shout = (text: string) => text.toUpperCase()\n',
      'src/components/dot.kay': 'i.dot\n',
      'src/components/badge.kay': '---\nimport Dot from \'./dot.kay\'\nimport { shout } from \'./shout\'\n\nconst { labels } = props<{ labels: string[] }>()\n---\nul.badges\n  for label of labels key={label}\n    li\n      Dot\n      | {shout(label)}\n',
      'src/components/tally.kay': '---\nimport { signal } from \'kay\'\nimport Badge from \'./badge.kay\'\n\nconst n = signal(0)\n---\nBadge(labels={[\'in\']})\nbutton(onClick={() => n.set(c => c + 1)}) {n()}\n',
      'src/routes/badges.kay': '---\nimport Badge from \'../components/badge.kay\'\nimport Tally from \'../components/tally.kay\'\n---\nBadge(labels={[\'out\']})\nTally\n',
      'src/routes/about.kay': '--- server\nexport const page = { prerender: true }\n---\np About\n',
      'src/routes/echo.kay': '--- server\nimport { t } from \'elysia\'\nimport { action } from \'kay\'\n\nexport const shout = action(t.Object({ text: t.String({ maxLength: 200 }) }), ({ text }) => text.toUpperCase())\n---\np Echo\n',
      'src/routes/admin/_guard.ts': 'import { guard } from \'kay\'\n\nexport default guard(({ deny }) => deny(403, \'Admins only\'))\n',
      'src/routes/admin/index.kay': 'p Secret\n',
      'src/content.config.ts': 'import { t } from \'elysia\'\nimport { collection } from \'kay/content\'\n\nexport const notes = collection(\'content/notes\', {\n  schema: t.Object({ title: t.String(), date: t.Date() }),\n  feed: { path: \'/notes.xml\', title: \'Notes\', item: note => ({ title: note.data.title, path: `/notes/${note.slug}`, date: note.data.date }) },\n})\n',
      'src/content/notes/first.md': '---\ntitle: First note\ndate: 2026-09-01\n---\n\n## Read me\n',
      'src/routes/notes/[slug].kay': '--- server\nimport { notes } from \'../../content.config\'\n\nconst note = await notes.get(ctx.params.slug) ?? ctx.notFound()\nconst { Content } = note\n---\nh1 {note.data.title}\nContent\n',
      'src/routes/photo.kay': '---\nimport { image } from \'kay/image\'\nimport hero from \'../hero.png\'\n---\nimg({...image(hero)} alt="Hero")\n',
      // An island loading wasm and starting a module worker, which the executable serves from its build.
      'src/routes/lab.kay': '---\nimport { onMount, signal } from \'kay\'\nimport wasm from \'../add.wasm\'\n\nconst echoed = signal(\'\')\n\nonMount(() => {\n  const worker = new Worker(new URL(\'../echo.ts\', import.meta.url), { type: \'module\' })\n\n  worker.onmessage = (event: MessageEvent<string>) => echoed.set(event.data)\n})\n---\np.wasm {wasm}\np {echoed()}\n',
      'src/api/ping.ts': 'import { Elysia } from \'elysia\'\n\nexport default new Elysia().get(\'/\', () => \'pong\')\n',
      'src/api/members/_guard.ts': 'import { guard } from \'kay\'\n\nexport default guard(({ deny }) => deny(403, \'Members only\'))\n',
      'src/api/members/index.ts': 'import { Elysia } from \'elysia\'\n\nexport default new Elysia().get(\'/\', () => \'secret\')\n',
      // A kay library whose settings the app replaces, on a page the build prerenders and one the executable renders.
      'node_modules/kay-lib/package.json': JSON.stringify({ name: 'kay-lib', version: '1.0.0', type: 'module', peerDependencies: { kay: '*' }, exports: { './*.kay': './src/*.kay' }, kay: { settings: './src/settings.ts' } }),
      'node_modules/kay-lib/src/settings.ts': 'export default { icon: (name: string) => `default:${name}` }\n',
      'node_modules/kay-lib/src/tag.kay': '---\nimport { signal } from \'kay\'\nimport settings from \'./settings\'\n\nconst { label } = props<{ label: string }>()\nconst open = signal(false)\n---\nbutton.tag(onClick={() => open.set(o => !o)}) {settings.icon(label)}\n',
      'src/ui-settings.ts': 'export default { icon: (name: string) => `app:${name}` }\n',
      'src/routes/tags.kay': '---\nimport Tag from \'kay-lib/tag.kay\'\n---\n--- server\nexport const page = { prerender: true }\n---\nTag(label="kept")\n',
      'src/routes/live-tags.kay': '---\nimport Tag from \'kay-lib/tag.kay\'\n---\nTag(label="live")\n',
      // A build plugin reading a file beside it as it loads, as a native binding does: the executable must not load it.
      'node_modules/build-stamp/package.json': JSON.stringify({ name: 'build-stamp', version: '1.0.0', type: 'module', exports: { types: './index.d.ts', default: './index.js' } }),
      'node_modules/build-stamp/index.d.ts': 'declare const stamp: () => import(\'bun\').BunPlugin\nexport default stamp\n',
      'node_modules/build-stamp/index.js': 'import { readFileSync } from \'node:fs\'\nimport { join } from \'node:path\'\n\nconst binding = readFileSync(join(import.meta.dir, \'binding.txt\'), \'utf8\')\n\nexport default () => ({ name: binding, setup() {} })\n',
      'node_modules/build-stamp/binding.txt': 'stamp',
      'kay.config.ts': 'import stamp from \'build-stamp\'\nimport { defineConfig } from \'kay/server\'\n\nexport default defineConfig({ plugins: [stamp()], lang: \'en\', site: \'https://example.com\', favicon: \'src/favicon.png\', fonts: [{ family: \'Display\', src: \'src/display.woff2\' }], settings: { \'kay-lib\': \'./src/ui-settings.ts\' }, images: { dirs: { \'/uploads/\': \'uploads\' } } })\n',
    }).map(async ([path, content]) => Bun.write(join(dir, path), content)))
    // Images, the favicon and fonts are read from the project at build time only: the executable serves what the build made of them.
    await Promise.all([
      Bun.write(join(dir, 'src/hero.png'), Bun.file(join(repo, 'tests/fixtures/images/src/hero.png'))),
      Bun.write(join(dir, 'src/favicon.png'), Bun.file(join(repo, 'tests/fixtures/seo/src/favicon.png'))),
      Bun.write(join(dir, 'src/display.woff2'), Bun.file(join(repo, 'tests/fixtures/seo/src/fonts/display.woff2'))),
      Bun.write(join(dir, 'src/add.wasm'), Bun.file(join(repo, 'tests/fixtures/workers/src/add.wasm'))),
      Bun.write(join(dir, 'src/echo.ts'), Bun.file(join(repo, 'tests/fixtures/workers/src/echo.ts'))),
    ])

    const manifest = await Bun.file(join(dir, 'package.json')).json() as { dependencies: Record<string, string> }

    await Bun.write(join(dir, 'package.json'), JSON.stringify({ ...manifest, dependencies: { ...manifest.dependencies, 'kay-lib': '1.0.0' } }))

    const build = Bun.spawn([process.execPath, join(repo, 'src/cli.ts'), 'build', '--compile', 'server'], { cwd: dir, stdout: 'pipe', stderr: 'pipe' })
    const [report, code] = await Promise.all([new Response(build.stdout).text(), build.exited])

    expect(report).toContain('compiled server in ')
    expect(code).toBe(0)
    // For `kay start` to run.
    expect(await Bun.file(join(outputDir(dir), 'executable')).text()).toBe('server')
    // Serving the build it embeds, it carries neither kay's compiler nor Babel, and loads zlib, crypto, http, net and SQLite only once a feature needs them.
    const executable = Buffer.from(await Bun.file(join(dir, 'server')).bytes())

    // The compiler's parser, which the prerenderer and the dev tool's Head tab reach, is left out with them.
    expect(['compiler/codegen.ts', 'compiler/parser.ts'].filter(file => executable.includes(file))).toEqual([])
    expect(EAGER_BUILTINS.filter(statement => executable.includes(statement))).toEqual([])
    await rm(join(dir, 'node_modules/build-stamp'), { recursive: true })

    // Run from elsewhere, with nothing of the project to read but an upload.
    const elsewhere = join(dir, '..', 'elsewhere')

    await Bun.write(join(elsewhere, 'uploads/photo.png'), Bun.file(join(repo, 'tests/fixtures/images/src/hero.png')))

    // The temp directory the runtime images' variants go to is the run's.
    const server = Bun.spawn([join(dir, 'server')], { cwd: elsewhere, env: { PATH: process.env.PATH, PORT: '0', TMPDIR: tmpdir() }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })

    try {
      const port = await listeningPort(server, 'the executable', LISTENING)
      const origin = `http://localhost:${port}`
      const get = async (path: string) => {
        const response = await fetch(`${origin}${path}`)

        return { status: response.status, text: await response.text() }
      }
      const home = await get('/')
      const entry = (/<script type="module" src="([^"]+)"/).exec(home.text)![1]!
      const badges = await get('/badges')
      const about = await fetch(`${origin}/about`, { headers: { 'accept-encoding': 'br' } })
      const call = await fetch(`${origin}/_kay/action/src/routes/echo.kay/shout`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-kay-action': '1', 'origin': origin }, body: stringify({ text: 'hi' }) })

      expect(home.text).toContain('Hello from the server</h1>')
      expect((await get(entry)).status).toBe(200)
      expect(await get('/robots.txt')).toEqual({ status: 200, text: 'User-agent: *\n' })
      // The copy `kay build` prerendered and compressed, not a render.
      expect(about.headers.get('etag')).toEndWith('-br"')
      expect(await about.text()).toContain('<p>About</p>')
      expect(badges.text).toContain('<ul class="badges"><li><i class="dot"></i>OUT</li></ul>')
      expect(badges.text).toMatch(/<slot data-component="src\/components\/tally\.kay" data-props="\[\{\}\]" data-chunk="tally-\w+\.js"><!--\[--><ul class="badges"><li><!--\[--><i class="dot"><\/i><!--\]--><!--\[-->IN<!--\]--><\/li><\/ul><!--\]--><button>0<\/button><\/slot>/)
      expect(parse(await call.text())).toBe('HI')
      expect(await get('/admin')).toEqual({ status: 403, text: 'Admins only' })
      expect(await get('/api/ping')).toEqual({ status: 200, text: 'pong' })
      expect(await get('/api/members')).toEqual({ status: 403, text: 'Members only' })
      expect((await get('/missing')).text).toContain('Nothing here</h1>')

      const lab = await fetch(`${origin}/lab`)
      const wasm = await fetch(`${origin}${(/<p class="wasm">([^<]+)</).exec(await lab.text())![1]!}`)
      const worker = [...new Bun.Glob('.kay/*/dist/assets/echo-*.js').scanSync({ cwd: dir, dot: true })]

      expect(lab.headers.get('content-security-policy')).toContain('\'wasm-unsafe-eval\'')
      expect([wasm.status, wasm.headers.get('content-type')]).toEqual([200, 'application/wasm'])
      expect(worker).toHaveLength(1)
      expect(await (await fetch(`${origin}/_kay/assets/${basename(worker[0]!)}`)).text()).toContain('instantiateStreaming')

      const photo = await get('/photo')
      const variant = (/srcset="([^ "]+) 320w/).exec(photo.text)![1]!.replaceAll('&amp;', '&')
      const font = (/<style>@font-face\{font-family:"Display";src:url\("([^"]+)"\)/).exec(home.text)![1]!
      const image = await fetch(`${origin}${variant}`)

      expect(image.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
      expect((await new Bun.Image(await image.bytes()).metadata()).width).toBe(320)

      const avif = await fetch(`${origin}${variant}`, { headers: { accept: 'image/avif,image/webp' } })
      // Encoded on request, on the worker thread the executable carries.
      const upload = await fetch(`${origin}/_kay/image?src=${encodeURIComponent('/uploads/photo.png')}&w=320`, { headers: { accept: 'image/avif' } })

      expect([avif.headers.get('content-type'), avif.headers.get('vary')]).toEqual(['image/avif', 'accept, save-data'])
      expect(upload.headers.get('content-type')).toBe('image/avif')
      expect(new TextDecoder().decode((await upload.bytes()).subarray(4, 12))).toBe('ftypavif')
      expect((await fetch(`${origin}/favicon.ico`)).headers.get('content-type')).toBe('image/x-icon')
      expect((await get('/manifest.webmanifest')).status).toBe(200)
      expect((await get(font)).status).toBe(200)
      expect((await get('/sitemap.xml')).text).toContain('<loc>https://example.com/about</loc>')
      // Content entries come from what the build compiled, with nothing of src/content beside the executable.
      expect((await get('/notes/first')).text).toContain('<h1>First note</h1><h2 id="read-me"><a href="#read-me">Read me</a></h2>')
      expect((await get('/notes.xml')).text).toContain('<link>https://example.com/notes/first</link>')
      expect((await get('/tags')).text).toMatch(/<slot data-component="node_modules\/kay-lib\/src\/tag\.kay" data-props='\[\{"label":1\},"kept"\]' data-chunk="tag-\w+\.js"><button class="tag">app:kept<\/button><\/slot>/)
      expect((await get('/live-tags')).text).toContain('<button class="tag">app:live</button>')

      // A container's health check runs the executable again, asking the server beside it.
      const probe = async (on: string) => Bun.spawn([join(dir, 'server'), '--health'], { cwd: tmpdir(), env: { PATH: process.env.PATH, PORT: on }, stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' }).exited

      expect(await probe(String(port))).toBe(0)
      expect(await probe('1')).toBe(1)
    }
    finally {
      server.kill()
      await server.exited
    }
  }, 120_000)
})
