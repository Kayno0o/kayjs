import { rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'bun:test'
import { implicitContextKeys } from '../src/server/context-reads'
import { kayCheck } from './check-helper'
import { scratchDir } from './scratch'

const TIMEOUT = 120_000
const projects: string[] = []

const CONTEXT = 'import { defineContext } from \'kay/library\'\n\nexport default defineContext({ inbox: () => true })\n'

// An app installing a library whose package.json declares the `context` module its components read `ctx` by, with or without the extension in its config.
async function project(config: string, component: string): Promise<string> {
  const root = await scratchDir('library-context-check-')

  projects.push(root)

  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'app', private: true, dependencies: { ctxlib: '*' } }),
    'tsconfig.json': JSON.stringify({ compilerOptions: { target: 'ESNext', jsx: 'preserve', jsxImportSource: 'kay', lib: ['ESNext', 'DOM', 'DOM.Iterable'], rootDirs: ['.', '.kay/types'], module: 'Preserve', moduleResolution: 'bundler', strict: true, noEmit: true, skipLibCheck: true }, include: ['src', '.kay/types'] }),
    'kay.config.ts': config,
    'src/routes/index.kay': '---\nimport Bell from \'ctxlib/bell.kay\'\n---\nBell()\n',
    'node_modules/ctxlib/package.json': JSON.stringify({ name: 'ctxlib', version: '1.0.0', peerDependencies: { kay: '*' }, kay: { context: './context.ts' }, exports: { './*.kay': './bell.kay', './extension': './extension.ts' } }),
    'node_modules/ctxlib/context.ts': CONTEXT,
    'node_modules/ctxlib/extension.ts': `export default () => ({ name: 'ctxlib', context: ${JSON.stringify(join(root, 'node_modules/ctxlib/context.ts'))} })\n`,
    'node_modules/ctxlib/bell.kay': component,
  }

  await Promise.all(Object.entries(files).map(async ([path, text]) => Bun.write(join(root, path), text)))

  return root
}

afterAll(async () => {
  await Promise.all(projects.map(async dir => rm(dir, { recursive: true, force: true })))
})

async function check(root: string): Promise<{ code: number, output: string }> {
  const { code, output, report } = await kayCheck([root])

  return { code, output: `${report}${output}` }
}

const CLEAN = /checked with no problems in \d+ ms/
const READS_INBOX = 'if ctx.inbox\n  p yes\n'
const PLAIN = 'export default {}\n'
const CALLING = 'import ctxlib from \'ctxlib/extension\'\n\nexport default { extensions: [ctxlib()] }\n'

describe('a library component reading its extension\'s ctx key', () => {
  it('is typed in an app calling the extension', async () => {
    const { code, output } = await check(await project(CALLING, READS_INBOX))

    expect(output.slice(0, 600)).toMatch(CLEAN)
    expect(code).toBe(0)
  }, TIMEOUT)

  it('is typed in an app that does not call it', async () => {
    const { code, output } = await check(await project(PLAIN, READS_INBOX))

    expect(output.slice(0, 600)).toMatch(CLEAN)
    expect(code).toBe(0)
  }, TIMEOUT)

  it('stays a type error for a key no extension declares', async () => {
    const { code, output } = await check(await project(PLAIN, 'if ctx.nope\n  p yes\n'))

    expect(output).toContain('bell.kay')
    expect(output).toContain('\'nope\'')
    expect(code).not.toBe(0)
  }, TIMEOUT)

  it('stays a type error in an app calling the extension', async () => {
    const { code, output } = await check(await project(CALLING, 'if ctx.nope\n  p yes\n'))

    expect(output).toContain('\'nope\'')
    expect(code).not.toBe(0)
  }, TIMEOUT)
})

describe('the keys the Bell reads off ctx', () => {
  it('are `inbox` alone, so a page reaching it loads that one context key', async () => {
    expect(implicitContextKeys(await Bun.file(resolve('packages/ui/src/bell.kay')).text())).toEqual(['inbox'])
  })
})
