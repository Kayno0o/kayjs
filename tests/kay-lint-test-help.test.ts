import { join } from 'node:path'
import process from 'node:process'
import { expect, it } from 'bun:test'
import { takeFormat } from '../src/commands/command'
import { scratchDir } from './scratch'

const CLI = join(import.meta.dir, '..', 'src', 'cli.ts')

async function kay(args: string[], cwd: string) {
  const child = Bun.spawn([process.execPath, CLI, ...args], { cwd, env: { ...process.env, NO_COLOR: '1' }, stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])

  return { stdout, stderr, code }
}

// A project with a `keslint` that prints its arguments, and one passing test.
async function project(): Promise<string> {
  const root = await scratchDir('kay-lint-test-help-')

  await Bun.write(join(root, 'package.json'), '{ "name": "app", "type": "module" }')
  await Bun.write(join(root, 'tsconfig.json'), '{}')
  await Bun.write(join(root, 'kay.config.ts'), 'export default { favicon: false }\n')
  await Bun.write(join(root, 'node_modules/.bin/keslint'), '#!/bin/sh\necho "keslint $@"\n')
  await Bun.$`chmod +x ${join(root, 'node_modules/.bin/keslint')}`
  await Bun.write(join(root, 'a.test.ts'), 'import { expect, it } from \'bun:test\'\nit(\'works\', () => expect(1).toBe(1))\n')

  return root
}

it('opens kay lint --help with what kay adds, then keslint\'s help', async () => {
  const { stdout, code } = await kay(['lint', '--help'], await project())

  expect(code).toBe(0)
  expect(stdout.startsWith('kay lint writes the types')).toBe(true)
  expect(stdout).toContain('keslint --help')
})

it('opens kay test --help with what kay adds, then bun test\'s help', async () => {
  const { stdout, code } = await kay(['test', '--help'], await project())

  expect(code).toBe(0)
  expect(stdout.startsWith('kay test runs bun test')).toBe(true)
  expect(stdout).toContain('Usage: bun test')
})

it('prints one JSON document for kay test --format json, the report on stderr', async () => {
  const { stdout, stderr, code } = await kay(['test', '--format', 'json'], await project())

  expect(code).toBe(0)
  expect(JSON.parse(stdout)).toMatchObject({ ok: true, exitCode: 0, pass: 1, fail: 0, files: 1 })
  expect(stderr).toContain('1 pass')
})

it('hands keslint --format json for kay lint --format json', async () => {
  const { stdout, code } = await kay(['lint', '--format', 'json', 'a.ts'], await project())

  expect(code).toBe(0)
  expect(stdout.trim()).toBe('keslint --format json a.ts')
})

it('keeps a formatter that is not json or text for the tool', () => {
  expect(takeFormat(['--format', 'stylish', 'a.ts'])).toEqual(['--', '--format', 'stylish', 'a.ts'])
  expect(takeFormat(['a.ts', '--format=json'])).toEqual(['--format', 'json', '--', 'a.ts'])
})

it('describes --editor in kay new --help', async () => {
  const { stdout } = await kay(['new', '--help'], await project())

  expect(stdout).toMatch(/--editor <value>\s+the editors to set up/)
})
