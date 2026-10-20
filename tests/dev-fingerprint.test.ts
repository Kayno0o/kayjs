import type { ClientOptions } from '../src/build/client'
import { existsSync, readdirSync, rmSync, statSync, utimesSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { clientDir, outputDir } from '../src/build/assets'
import { devBuilder } from '../src/dev/builder'
import { FINGERPRINT } from '../src/dev/fingerprint'
import { BUILD_FAILURE } from '../src/server/client'
import { scratchDir } from './scratch'

const OPTIONS: ClientOptions = { hot: true, sourcemap: true }
const ISLAND = (label: string) => `---\nimport { shout } from './util'\n\nconst count = signal(0)\n---\nbutton(onClick={() => count.set(count() + 1)}) ${label} {shout(count())}\n`
const FILES: Record<string, string> = {
  'package.json': '{ "name": "fingerprint", "version": "1.0.0" }\n',
  'src/util.ts': 'export const shout = (value: number) => `${value}!`\n',
  'src/one.kay': ISLAND('one'),
  'src/app.css': 'h1 { color: red }\n',
  'src/routes/index.kay': '---\nimport \'../app.css\'\nimport One from \'../one.kay\'\n---\nh1 Home\nOne\n',
  'public/logo.txt': 'logo\n',
  'tests/note.ts': 'export const note = 1\n',
}

let project = ''
const cwd = process.cwd()

beforeEach(async () => {
  project = await scratchDir('kay-dev-fingerprint-')
  process.chdir(project)
})

afterEach(async () => {
  process.chdir(cwd)
  await rm(project, { recursive: true, force: true })
})

// Written a minute ago, as sources are by the time a project is started again: a file written just before a build cannot be told apart from one changed while it read it.
async function write(files: Record<string, string>, settled = true): Promise<void> {
  const past = new Date(Date.now() - 60_000)

  for (const [file, content] of Object.entries(files)) {
    await mkdir(dirname(join(project, file)), { recursive: true })
    await Bun.write(join(project, file), content)

    if (settled)
      utimesSync(join(project, file), past, past)
  }
}

async function recorded(): Promise<void> {
  for (const start = Date.now(); !existsSync(join(outputDir(project), FINGERPRINT)); await Bun.sleep(10)) {
    if (Date.now() - start > 15_000)
      throw new Error('no fingerprint was written')
  }
}

const manifest = () => statSync(join(outputDir(project), 'manifest.json')).mtimeMs

// A first build, of everything, as a process just started asks for.
async function firstRun(options = OPTIONS, files = FILES) {
  await write(files)
  const build = devBuilder(project, options)

  expect((await build(null)).failed).toBe(false)
  await recorded()

  return build
}

// Whether a builder started now builds again, rather than leaving the output as the run before did.
async function buildsAgain(options = OPTIONS): Promise<boolean> {
  const before = manifest()

  await Bun.sleep(30)

  const outcome = await devBuilder(project, options)(null)

  expect(outcome.failed).toBe(false)

  const rebuilt = manifest() !== before

  if (rebuilt)
    await recorded()

  return rebuilt
}

describe('the build an earlier kay dev left', () => {
  it('stays as it is when nothing the build read has changed', async () => {
    await firstRun()
    expect(await buildsAgain()).toBe(false)
    // And again: leaving it did not spend the record.
    expect(await buildsAgain()).toBe(false)
  })

  it('stays for a file no build reads, a test or a hidden directory', async () => {
    await firstRun()
    await write({ 'tests/note.ts': 'export const note = 2\n', '.cache/state.json': '{}', 'README.md2': 'x' }, false)
    expect(await buildsAgain()).toBe(false)
  })

  it.each([
    ['a component', { 'src/one.kay': ISLAND('uno') }],
    ['a page', { 'src/routes/index.kay': '---\nimport \'../app.css\'\nimport One from \'../one.kay\'\n---\nh1 Changed\nOne\n' }],
    ['a stylesheet', { 'src/app.css': 'h1 { color: blue }\n' }],
    ['a script an island imports', { 'src/util.ts': 'export const shout = (value: number) => `${value}?`\n' }],
    ['a public file', { 'public/logo.txt': 'changed\n' }],
    ['package.json', { 'package.json': '{ "name": "fingerprint", "version": "1.0.1" }\n' }],
    ['the lockfile', { 'bun.lock': '{}\n' }],
    ['tsconfig.json', { 'tsconfig.json': '{}\n' }],
    ['a component added', { 'src/two.kay': ISLAND('two'), 'src/routes/index.kay': '---\nimport \'../app.css\'\nimport One from \'../one.kay\'\nimport Two from \'../two.kay\'\n---\nh1 Home\nOne\nTwo\n' }],
    ['a public file added', { 'public/other.txt': 'x\n' }],
    ['a root Markdown file a stylesheet is pruned by', { 'NOTES.md': 'x\n' }],
  ] as const)('is built again after %s changed while kay dev was down', async (_name, edit) => {
    await firstRun()
    await write(edit)
    expect(await buildsAgain()).toBe(true)
  })

  it.each([
    ['a component', 'src/one.kay'],
    ['a public file', 'public/logo.txt'],
    ['a stylesheet', 'src/app.css'],
    ['package.json', 'package.json'],
  ])('is built again after %s was deleted while kay dev was down', async (_name, file) => {
    await firstRun()
    rmSync(join(project, file))
    // A deleted import fails the build, which still builds.
    const before = manifest()

    await Bun.sleep(30)
    await devBuilder(project, OPTIONS)(null)
    expect(statSync(join(outputDir(project), 'manifest.json'), { throwIfNoEntry: false })?.mtimeMs !== before || existsSync(join(outputDir(project), BUILD_FAILURE))).toBe(true)
  })

  it('is built again for another client option, kay or Bun version', async () => {
    await firstRun()
    expect(await buildsAgain({ ...OPTIONS, base: '/site' })).toBe(true)
    await firstRun()
    expect(await buildsAgain({ ...OPTIONS, minify: true })).toBe(true)

    for (const field of ['identity', 'options'] as const) {
      await firstRun()

      const record = join(outputDir(project), FINGERPRINT)
      const saved = await Bun.file(record).json() as Record<string, unknown>

      await Bun.write(record, JSON.stringify({ ...saved, [field]: `${String(saved[field])} older` }))
      expect(await buildsAgain()).toBe(true)
    }
  })

  it('is built again when its record is half written, or its output was touched', async () => {
    await firstRun()
    await Bun.write(join(outputDir(project), FINGERPRINT), '{"identity":')
    expect(await buildsAgain()).toBe(true)

    expect(await buildsAgain()).toBe(false)

    const [chunk] = readdirSync(clientDir(project)).filter(file => file.endsWith('.js'))

    await Bun.write(join(clientDir(project), chunk!), 'console.log(1)')
    expect(await buildsAgain()).toBe(true)

    await recorded()
    rmSync(join(clientDir(project), readdirSync(clientDir(project)).find(file => file.endsWith('.js'))!))
    expect(await buildsAgain()).toBe(true)

    await recorded()
    await Bun.write(join(outputDir(project), 'manifest.json'), '{"entryImports":[],"islands":{},"styles":{}}')
    expect(await buildsAgain()).toBe(true)
  })

  it('is built again after a build that failed, and leaves no record of it', async () => {
    await firstRun()
    await write({ 'src/one.kay': '---\nconst = \n---\np\n' })

    const build = devBuilder(project, OPTIONS)

    expect((await build(null)).failed).toBe(true)
    expect(existsSync(join(outputDir(project), FINGERPRINT))).toBe(false)
    expect(existsSync(join(outputDir(project), BUILD_FAILURE))).toBe(true)

    await write({ 'src/one.kay': ISLAND('fixed') })
    expect(await buildsAgain()).toBe(true)
    expect(existsSync(join(outputDir(project), BUILD_FAILURE))).toBe(false)
  })

  it('is built again for a file written just before the build began, which a second write could leave with the same stamp', async () => {
    await write(FILES, false)

    const build = devBuilder(project, OPTIONS)

    expect((await build(null)).failed).toBe(false)
    await recorded()
    expect(await buildsAgain()).toBe(true)
    await recorded()
    // The record of that build stands, the files being old by then.
    await write(FILES)
    expect(await buildsAgain()).toBe(true)
    await recorded()
    expect(await buildsAgain()).toBe(false)
  })

  it('takes the edits one process built as built, and the ones it did not as changes', async () => {
    const build = await firstRun()

    await Bun.write(join(project, 'src/one.kay'), ISLAND('edited'))
    expect((await build(['src/one.kay'])).failed).toBe(false)
    await Bun.sleep(100)
    await recorded()
    // Written a moment ago, but read by the build that followed.
    expect(await buildsAgain()).toBe(false)

    await Bun.write(join(project, 'src/util.ts'), 'export const shout = (value: number) => `${value}#`\n')
    expect(await buildsAgain()).toBe(true)
  })

  it('does not record a build an edit began over, and records the next', async () => {
    const build = await firstRun()

    await Bun.write(join(project, 'src/one.kay'), ISLAND('edited'))

    const first = build(['src/one.kay'])

    await Bun.write(join(project, 'src/util.ts'), 'export const shout = (value: number) => `${value}$`\n')

    const second = build(['src/util.ts'])

    await first
    await second
    await Bun.sleep(100)
    await recorded()
    expect(await buildsAgain()).toBe(false)
  })
})
