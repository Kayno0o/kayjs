import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { expect, it } from 'bun:test'
import { check, configCheckOptions } from '../src/check'
import { loadConfig } from '../src/config'
import { generate, generatedFiles } from '../src/generate'
import { createProject, PRESETS } from '../src/new'
import { lintInProcess } from './scaffold-lint'
import { scratchDir } from './scratch'

const repo = join(import.meta.dir, '..')

async function run(dir: string, ...args: string[]) {
  const child = Bun.spawn([process.execPath, join(repo, 'src/cli.ts'), ...args], { cwd: dir, stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])

  return { stdout, stderr, code }
}

it('writes a page with its test, Tailwind classes only when the project has Tailwind', () => {
  const plain = generatedFiles('page', 'contact-us', { tailwind: false, tests: true, auth: false })
  const styled = generatedFiles('page', 'blog/[slug]', { tailwind: true, tests: true, auth: false })

  expect(plain['src/routes/contact-us.kay']).toBe('head\n  title Contact us\nh1 Contact us\n')
  expect(plain['tests/contact-us.test.ts']).toContain('site.visit(\'/contact-us\')')
  expect(Object.keys(styled)).toEqual(['src/routes/blog/[slug].kay'])
  expect(styled['src/routes/blog/[slug].kay']).toContain('h1.text-3xl.font-bold [slug]')
  expect(Object.keys(generatedFiles('page', '(shop)/index', { tailwind: false, tests: false, auth: false }))).toEqual(['src/routes/(shop)/index.kay'])
  expect(generatedFiles('page', 'pricing', { tailwind: false, tests: true, auth: true })['tests/pricing.test.ts']).toContain('/auth/sign-in')
})

it('refuses names that are no route, component or action', () => {
  const project = { tailwind: false, tests: false, auth: false }

  expect(() => generatedFiles('page', '../etc', project)).toThrow('is not a name for a page')
  expect(() => generatedFiles('component', 'a b', project)).toThrow('is not a name for a component')
  expect(() => generatedFiles('component', '[x]', project)).toThrow('is not a name for a component')
  expect(() => generatedFiles('action', 'remove-tissue', project)).toThrow('is not a name for an action')
  expect(() => generatedFiles('api', '/', project)).toThrow('is not a name for a api')
})

it('writes into a project, refusing a file that exists and honouring --dry-run', async () => {
  const dir = join(await scratchDir('generate-'), 'app')

  await createProject(dir, { kay: '^1.0.0', features: PRESETS.site.features })

  expect((await generate(dir, 'page', 'pricing', { dryRun: true })).written).toEqual(['src/routes/pricing.kay', 'tests/pricing.test.ts'])
  expect(await Bun.file(join(dir, 'src/routes/pricing.kay')).exists()).toBe(false)

  await generate(dir, 'page', 'pricing')
  await expect(generate(dir, 'page', 'pricing')).rejects.toThrow('nothing was written, src/routes/pricing.kay, tests/pricing.test.ts already exist')
  await expect(generate(dir, 'widget', 'x')).rejects.toThrow('widget is none of page')
  await expect(generate(join(dir, 'src'), 'page', 'x')).rejects.toThrow('no package.json')
  await generate(dir, 'action', 'save')
  await expect(generate(dir, 'action', 'action')).rejects.toThrow('that are no reserved word')
  await expect(generate(dir, 'page', 'save')).resolves.toEqual({ written: ['src/routes/save.kay', 'tests/save.test.ts'] })
  await expect(generate(dir, 'page', 'pricing/index')).rejects.toThrow('src/routes/pricing.kay already exists')
  await expect(generate(dir, 'action', 'interface')).rejects.toThrow('that are no reserved word')
  await expect(generate(dir, 'action', 'package')).rejects.toThrow('that are no reserved word')
  await expect(generate(dir, 'action', 'eval')).rejects.toThrow('that are no reserved word')
  await expect(generate(dir, 'action', 'arguments')).rejects.toThrow('that are no reserved word')
})

it('skips the rival of the root index page', async () => {
  const dir = join(await scratchDir('generate-'), 'app')

  await createProject(dir, { kay: '^1.0.0', features: PRESETS.site.features })
  await rm(join(dir, 'src/routes/index.kay'), { force: true })
  await Bun.write(join(dir, 'src/routes.kay'), 'h1 Rival\n')

  expect((await generate(dir, 'page', 'index')).written).toContain('src/routes/index.kay')
  await expect(generate(dir, 'page', 'team/index')).resolves.toBeDefined()
  await Bun.write(join(dir, 'src/routes/docs.kay'), 'h1 Docs\n')
  await expect(generate(dir, 'page', 'docs/index')).rejects.toThrow('src/routes/docs.kay already exists')
})

it('adds an action to an existing _actions.kay that holds a server fence alone', async () => {
  const dir = join(await scratchDir('generate-'), 'app')
  const actions = join(dir, 'src/routes/team/_actions.kay')

  await createProject(dir, { kay: '^1.0.0', features: PRESETS.server.features })
  await generate(dir, 'action', 'team/first')

  expect(await Bun.file(actions).text()).toStartWith('--- server\nimport { s } from \'kay\'\n')

  expect((await generate(dir, 'action', 'team/second', { dryRun: true })).written).toEqual(['src/routes/team/_actions.kay', 'tests/action-team-second.test.ts'])
  expect(await Bun.file(actions).text()).not.toContain('second')

  expect((await generate(dir, 'action', 'team/second')).written).toEqual(['src/routes/team/_actions.kay', 'tests/action-team-second.test.ts'])

  const text = await Bun.file(actions).text()

  expect(text.match(/import \{ s \}/g)).toHaveLength(1)
  expect(text).toContain('export const first = action(')
  expect(text).toContain('\n\nexport const second = action(')
  expect(text.endsWith(')\n')).toBe(true)

  await expect(generate(dir, 'action', 'team/second')).rejects.toThrow('already exports `second`')
  await expect(generate(dir, 'action', 'team/first')).rejects.toThrow('already exports `first`')
  expect(await Bun.file(actions).text()).toBe(text)

  await Bun.write(actions, '--- server\nexport const legacy = action(s.Object({}), () => 1)\n')
  await generate(dir, 'action', 'team/third')
  expect(await Bun.file(actions).text()).toStartWith('--- server\nimport { s } from \'kay\'\n\nexport const legacy')

  await Bun.write(actions, '--- server\r\nimport { a } from \'a\'\r\nexport function* team() {}\r\n')
  await generate(dir, 'action', 'team/crlf')
  expect(await Bun.file(actions).text()).toStartWith('--- server\r\nimport { a } from \'a\'\r\nimport { s } from \'kay\'\r\nexport function* team() {}\r\n\r\nexport const crlf = action(')
  expect(await Bun.file(actions).text()).not.toMatch(/[^\r]\n/)
  await expect(generate(dir, 'action', 'team/team')).rejects.toThrow('already exports `team`')

  const declared: [source: string, name: string, message: string][] = [
    ['export const { picked } = make()', 'picked', 'already exports'],
    ['import { s } from \'kay\'\nimport helper from \'./helper\'', 'helper', 'already declares or imports'],
    ['import {\n  other as renamed,\n  more,\n} from \'./x\'', 'renamed', 'already declares or imports'],
    ['const local = 1', 'local', 'already declares or imports'],
    ['const { a: inner } = make()', 'inner', 'already declares or imports'],
  ]

  for (const [source, name, message] of declared) {
    await Bun.write(actions, `--- server\n${source}\n`)
    await expect(generate(dir, 'action', `team/${name}`)).rejects.toThrow(message)
    expect(await Bun.file(actions).text()).toBe(`--- server\n${source}\n`)
  }

  await Bun.write(actions, '--- server\nimport { other as renamed } from \'./x\'\nconst { a: inner } = make()\n')
  await generate(dir, 'action', 'team/other')
  await generate(dir, 'action', 'team/a')

  await Bun.write(actions, '--- server\nimport { s } from \'kay\'\n\nexport const sent = action(s.Object({}), () => 1)\n---\nbutton Go\n')
  await expect(generate(dir, 'action', 'team/fourth')).rejects.toThrow('add the action by hand')
  expect(await Bun.file(actions).text()).toContain('button Go')
  expect(await Bun.file(join(dir, 'tests/action-team-fourth.test.ts')).exists()).toBe(false)
})

it('writes a guard test visiting a page below the folder when there is one', async () => {
  const dir = join(await scratchDir('generate-'), 'app')

  await createProject(dir, { kay: '^1.0.0', features: PRESETS.server.features })
  await Bun.write(join(dir, 'src/routes/admin/users/[id].kay'), 'h1 User\n')
  await Bun.write(join(dir, 'src/routes/admin/users/index.kay'), 'h1 Users\n')

  expect((await generate(dir, 'guard', 'admin')).written).toEqual(['src/routes/admin/_guard.ts', 'tests/guard-admin.test.ts'])
  expect(await Bun.file(join(dir, 'tests/guard-admin.test.ts')).text()).toContain('site.visit(\'/admin/users\')')

  // A `(group)` folder is part of the glob's syntax; a `[param]` one has no page to visit.
  await Bun.write(join(dir, 'src/routes/(staff)/desk.kay'), 'h1 Desk\n')
  await Bun.write(join(dir, 'src/routes/[org]/home.kay'), 'h1 Home\n')
  expect((await generate(dir, 'guard', '(staff)')).written).toEqual(['src/routes/(staff)/_guard.ts', 'tests/guard-staff.test.ts'])
  expect(await Bun.file(join(dir, 'tests/guard-staff.test.ts')).text()).toContain('site.visit(\'/desk\')')
  expect((await generate(dir, 'guard', '[org]')).written).toEqual(['src/routes/[org]/_guard.ts'])
  await rm(join(dir, 'src/routes'), { recursive: true })
  expect((await generate(dir, 'guard', 'norouts')).written).toEqual(['src/routes/norouts/_guard.ts'])
  expect((await generate(dir, 'guard', 'empty')).written).toEqual(['src/routes/empty/_guard.ts'])
  expect(generatedFiles('guard', 'admin', { tailwind: false, tests: true, auth: true, guardPage: '/admin' })['tests/guard-admin.test.ts']).toContain('/auth/sign-in')
})

it('runs as kay generate', async () => {
  const dir = join(await scratchDir('generate-'), 'app')

  await createProject(dir, { kay: '^1.0.0', features: PRESETS.server.features })

  const made = await run(dir, 'generate', 'component', 'card')

  expect(made.code).toBe(0)
  expect(made.stdout).toContain('generated component card, 1 file written')
  expect(made.stdout).toContain('src/components/card.kay')
  expect(JSON.parse((await run(dir, 'generate', 'island', 'likes', '--format', 'json', '--dry-run')).stdout)).toEqual({ kind: 'island', name: 'likes', written: ['src/components/likes.kay'], dryRun: true })

  const again = await run(dir, 'generate', 'component', 'card')

  expect(again.code).toBe(1)
  expect(again.stderr).toContain('nothing was written')
  expect((await run(dir, 'generate', 'page')).code).toBe(1)
})

// What it writes passes kay check and runs under bun test, in a project of the server preset.
it('writes files that pass kay check and their own tests', async () => {
  const dir = join(await scratchDir('generate-'), 'app')

  await createProject(dir, { kay: '^1.0.0', features: PRESETS.server.features })
  await mkdir(join(dir, 'src/routes'), { recursive: true })
  await Bun.write(join(dir, 'src/routes/admin/index.kay'), 'head\n  title Admin\nh1 Admin\n')

  for (const [kind, name] of [['page', 'pricing'], ['page', 'blog/[slug]'], ['component', 'card'], ['island', 'likes'], ['action', 'team/removeTissue'], ['action', 'save'], ['api', 'notes'], ['guard', 'admin']] as const)
    await generate(dir, kind, name)

  await generate(dir, 'action', 'team/addTissue')

  await Bun.write(join(dir, 'src/routes/team/index.kay'), 'head\n  title Team\nh1 Team\n')

  expect(await check(dir, configCheckOptions(await loadConfig(dir)))).toEqual([])

  expect((await lintInProcess(dir, '.')).filter(result => result.messages.length > 0).map(result => ({ file: result.filePath, messages: result.messages }))).toEqual([])

  const tests = await run(dir, 'test')

  expect(tests.stderr + tests.stdout).toContain(' 0 fail')
  expect(tests.code).toBe(0)
}, 120_000)
