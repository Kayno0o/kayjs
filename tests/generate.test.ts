import { mkdir } from 'node:fs/promises'
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
  await expect(generate(dir, 'action', 'send')).rejects.toThrow('add the action to its server fence by hand')
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

  for (const [kind, name] of [['page', 'pricing'], ['page', 'blog/[slug]'], ['component', 'card'], ['island', 'likes'], ['action', 'team/removeTissue'], ['action', 'save'], ['api', 'notes'], ['guard', 'admin']] as const)
    await generate(dir, kind, name)

  await Bun.write(join(dir, 'src/routes/team/index.kay'), 'head\n  title Team\nh1 Team\n')

  expect(await check(dir, configCheckOptions(await loadConfig(dir)))).toEqual([])

  expect((await lintInProcess(dir, '.')).filter(result => result.messages.length > 0).map(result => ({ file: result.filePath, messages: result.messages }))).toEqual([])

  const tests = await run(dir, 'test')

  expect(tests.stderr + tests.stdout).toContain(' 0 fail')
  expect(tests.code).toBe(0)
}, 120_000)
