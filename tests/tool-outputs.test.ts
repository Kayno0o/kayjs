import { existsSync, writeFileSync } from 'node:fs'
import { cp, mkdir, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, spyOn } from 'bun:test'
import { outputDir } from '../src/build/assets'
import { buildProject } from '../src/build/pipeline'
import { deriveToolOutputs } from '../src/check/tool-outputs'
import { nativeExe } from '../src/compiler/native-typescript'
import { loadConfig } from '../src/config-loader'
import { readToolOutputs, recordedToolOutputs, TOOL_OUTPUTS_RECORD } from '../src/server/tool-outputs'
import { fixtureCopy, scratchDir } from './scratch'

const SUMMARY = {
  type: 'object',
  properties: { count: { type: 'number' }, at: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } }, note: { type: 'string' } },
  required: ['count', 'at', 'tags'],
}

const WORDED = { type: 'object', properties: { count: { type: 'number' } }, required: ['count'] }

async function derive(dir: string): Promise<Record<string, unknown> | undefined> {
  const output = join(dir, '.kay', 'client')

  await deriveToolOutputs(dir, {}, output)

  const file = Bun.file(join(output, TOOL_OUTPUTS_RECORD))

  return await file.exists() ? (await file.json() as { outputs: Record<string, unknown> }).outputs : undefined
}

describe('the output schemas derived for tool actions', () => {
  it('records the schema of each tool action without an output, and of no other action', async () => {
    const dir = join(process.cwd(), await fixtureCopy('tool-outputs'))
    const outputs = await derive(dir)

    expect(outputs).toEqual({ 'src/routes/index.kay#summary': SUMMARY, 'src/routes/index.kay#worded': WORDED })
  })

  it('records the schema of an action whose options are a variable or whose tool is spread, as of an inline one', async () => {
    const dir = join(process.cwd(), await fixtureCopy('tool-outputs'))
    const file = join(dir, 'src/routes/index.kay')
    const extra = [
      'const options = { tool: true as const }',
      'const shared = { text: ({ count }: { count: number }) => `${count} things` }',
      'export const viaVariable = action(t.Object({}), () => ({ count: 1 }), options)',
      'export const viaSpread = action(t.Object({}), () => ({ count: 2 }), { tool: { ...shared } })',
      'export const viaSpreadOptions = action(() => ({ count: 3 }), { ...options })',
      '',
    ].join('\n')

    await Bun.write(file, (await Bun.file(file).text()).replace('---\nh1', `${extra}---\nh1`))

    const outputs = await derive(dir)

    expect(outputs).toEqual({ 'src/routes/index.kay#summary': SUMMARY, 'src/routes/index.kay#worded': WORDED, 'src/routes/index.kay#viaVariable': WORDED, 'src/routes/index.kay#viaSpread': WORDED, 'src/routes/index.kay#viaSpreadOptions': WORDED })
  })

  it('runs no tsgo for a project with no tool action, and leaves no record', async () => {
    const dir = join(process.cwd(), await fixtureCopy('tool-outputs'))

    await Bun.write(join(dir, 'src/routes/index.kay'), '--- server\nimport { t } from \'elysia\'\nimport { action } from \'kay\'\n\nexport const hidden = action(t.Object({}), () => 1)\n---\nh1 Hi\n')
    const spawned = spyOn(Bun, 'spawn')

    expect(await derive(dir)).toBeUndefined()
    expect(spawned).not.toHaveBeenCalled()
    spawned.mockRestore()
  })

  it('goes on past a type error in the app, and keeps the tool whose type it can read', async () => {
    const dir = join(process.cwd(), await fixtureCopy('tool-outputs'))
    const file = join(dir, 'src/routes/index.kay')

    await Bun.write(file, (await Bun.file(file).text()).replace('---\nh1', 'export const broken: number = \'no\'\n---\nh1'))

    expect(await derive(dir)).toEqual({ 'src/routes/index.kay#summary': SUMMARY, 'src/routes/index.kay#worded': WORDED })
  })

  it('reads the new return type after it changed, and drops a tool that stopped being one', async () => {
    const dir = join(process.cwd(), await fixtureCopy('tool-outputs'))
    const file = join(dir, 'src/routes/index.kay')

    await derive(dir)
    await Bun.write(file, (await Bun.file(file).text()).replace('count: 2, at', 'count: \'two\', at'))

    expect(((await derive(dir))!['src/routes/index.kay#summary'] as { properties: { count: unknown } }).properties.count).toEqual({ type: 'string' })

    await Bun.write(file, (await Bun.file(file).text()).replace(', note: undefined as string | undefined }), { tool: true })', ' }), {})'))

    expect(Object.keys((await derive(dir))!)).toEqual(['src/routes/index.kay#worded'])
  })
})

describe('the emit kept between runs', () => {
  // How many times tsgo was started while `run` ran.
  async function spawns(run: () => Promise<unknown>): Promise<number> {
    const spy = spyOn(Bun, 'spawn')

    try {
      await run()

      return spy.mock.calls.filter(([command]) => Array.isArray(command) && command[0] === nativeExe()).length
    }
    finally {
      spy.mockRestore()
    }
  }

  it('starts no tsgo for a project that did not change, in a build or beside kay dev, and still records', async () => {
    const dir = join(process.cwd(), await fixtureCopy('tool-outputs'))
    const config = await loadConfig(dir)
    const recorded = join(outputDir(dir), TOOL_OUTPUTS_RECORD)

    expect(await spawns(async () => derive(dir))).toBe(1)
    expect(await spawns(async () => derive(dir))).toBe(0)

    await rm(recorded, { force: true })
    expect(await spawns(async () => buildProject(dir, config, { check: false }))).toBe(0)
    expect((await Bun.file(recorded).json() as { outputs: object }).outputs).toEqual({ 'src/routes/index.kay#summary': SUMMARY, 'src/routes/index.kay#worded': WORDED })
    expect(await spawns(async () => deriveToolOutputs(dir, {}, join(dir, '.kay', 'dev'), { shadowed: true }))).toBe(0)
  })

  it('emits again when a source, a config or a linked package changed, and not for a file that types nothing', async () => {
    const dir = join(process.cwd(), await fixtureCopy('tool-outputs'))

    await derive(dir)
    await Bun.write(join(dir, 'notes.md'), 'x')
    expect(await spawns(async () => derive(dir))).toBe(0)

    await Bun.write(join(dir, 'src/helper.ts'), 'export const x = 1\n')
    expect(await spawns(async () => derive(dir))).toBe(1)

    await Bun.write(join(dir, 'tsconfig.json'), `${await Bun.file(join(dir, 'tsconfig.json')).text()}\n`)
    expect(await spawns(async () => derive(dir))).toBe(1)

    const linked = await scratchDir('linked-package-')

    await Bun.write(join(linked, 'index.ts'), 'export const y = 1\n')
    await mkdir(join(dir, 'node_modules/@scope'), { recursive: true })
    await symlink(linked, join(dir, 'node_modules/@scope/linked'))
    expect(await spawns(async () => derive(dir))).toBe(1)
    expect(await spawns(async () => derive(dir))).toBe(0)
    await Bun.write(join(linked, 'index.ts'), 'export const y = 2\n')
    expect(await spawns(async () => derive(dir))).toBe(1)
  })

  it('emits again for a package linked from a folder above, a lockfile above and a tsconfig extended from outside, and not for a dependency the installer linked', async () => {
    const above = await scratchDir('stamp-above-')
    const dir = join(above, 'apps/web')
    const workspace = join(above, 'packages/shared')
    const store = join(above, 'node_modules/.bun/dep@1.0.0/node_modules/dep')
    const base = join(above, 'tsconfig.base.json')

    await cp(join(process.cwd(), await fixtureCopy('tool-outputs')), dir, { recursive: true })

    const own = JSON.parse(await Bun.file(join(dir, 'tsconfig.json')).text()) as { compilerOptions: object }

    await Bun.write(join(workspace, 'index.ts'), 'export const a = 1\n')
    await Bun.write(join(store, 'index.ts'), 'export const b = 1\n')
    await Bun.write(base, JSON.stringify({ compilerOptions: own.compilerOptions }))
    await mkdir(join(above, 'node_modules/@scope'), { recursive: true })
    await symlink(workspace, join(above, 'node_modules/@scope/shared'))
    await symlink(store, join(above, 'node_modules/dep'))
    await Bun.write(join(dir, 'tsconfig.json'), JSON.stringify({ extends: '../../tsconfig.base.json', include: ['src', '.kay/types'] }))

    await derive(dir)
    expect(await spawns(async () => derive(dir))).toBe(0)

    await Bun.write(join(store, 'index.ts'), 'export const b = 2\n')
    expect(await spawns(async () => derive(dir))).toBe(0)

    await Bun.write(join(workspace, 'index.ts'), 'export const a = 2\n')
    expect(await spawns(async () => derive(dir))).toBe(1)

    await Bun.write(base, JSON.stringify({ compilerOptions: own.compilerOptions, extra: 1 }))
    expect(await spawns(async () => derive(dir))).toBe(1)

    await Bun.write(join(above, 'bun.lock'), '{}')
    expect(await spawns(async () => derive(dir))).toBe(1)
    expect(await spawns(async () => derive(dir))).toBe(0)
  })

  it('keeps the emit of a project with a type error, and reads the return type changed after it', async () => {
    const dir = join(process.cwd(), await fixtureCopy('tool-outputs'))
    const file = join(dir, 'src/routes/index.kay')

    await Bun.write(file, (await Bun.file(file).text()).replace('---\nh1', 'export const broken: number = \'no\'\n---\nh1'))
    expect(await derive(dir)).toEqual({ 'src/routes/index.kay#summary': SUMMARY, 'src/routes/index.kay#worded': WORDED })
    expect(await spawns(async () => derive(dir))).toBe(0)

    await Bun.write(file, (await Bun.file(file).text()).replace('count: 2, at', 'count: \'two\', at'))

    expect(((await derive(dir))!['src/routes/index.kay#summary'] as { properties: { count: unknown } }).properties.count).toEqual({ type: 'string' })
  })

  it('reads the types again with the declarations cache emptied, as --no-cache does', async () => {
    const dir = join(process.cwd(), await fixtureCopy('tool-outputs'))

    await derive(dir)
    expect(await spawns(async () => derive(dir))).toBe(0)
    await rm(join(dir, '.kay/cache'), { recursive: true, force: true })
    expect(await spawns(async () => derive(dir))).toBe(1)
  })

  it('keeps nothing of an emit that a write overlapped, and records nothing from it', async () => {
    const dir = join(process.cwd(), await fixtureCopy('tool-outputs'))
    const real = Bun.spawn.bind(Bun)
    const spy = spyOn(Bun, 'spawn').mockImplementation(((...args: Parameters<typeof Bun.spawn>) => {
      // An edit lands while tsgo runs.
      writeFileSync(join(dir, 'src/helper.ts'), `export const at = ${Date.now()}\n`)

      return real(...args)
    }) as typeof Bun.spawn)

    try {
      expect(await derive(dir)).toBeUndefined()
    }
    finally {
      spy.mockRestore()
    }

    expect(await spawns(async () => derive(dir))).toBe(1)
    expect(await derive(dir)).toEqual({ 'src/routes/index.kay#summary': SUMMARY, 'src/routes/index.kay#worded': WORDED })
  })
})

describe('kay build', () => {
  it('records the schemas beside the build, with or without a check, and none for a project with no tool action', async () => {
    const dir = join(process.cwd(), await fixtureCopy('tool-outputs'))
    const config = await loadConfig(dir)
    const recorded = join(outputDir(dir), TOOL_OUTPUTS_RECORD)

    expect((await buildProject(dir, config, { check: false })).failed).toBeUndefined()
    expect((await Bun.file(recorded).json() as { outputs: object }).outputs).toEqual({ 'src/routes/index.kay#summary': SUMMARY, 'src/routes/index.kay#worded': WORDED })

    await Bun.write(join(dir, 'src/routes/index.kay'), 'h1 Hi\n')
    expect((await buildProject(dir, config, { check: false })).failed).toBeUndefined()
    expect(existsSync(recorded)).toBe(false)
  })

  it('goes on with a type error in the app, and an executable holds the record', async () => {
    const dir = join(process.cwd(), await fixtureCopy('tool-outputs'))
    const file = join(dir, 'src/routes/index.kay')

    await Bun.write(file, (await Bun.file(file).text()).replace('---\nh1', 'export const broken: number = \'no\'\n---\nh1'))
    expect((await buildProject(dir, await loadConfig(dir), { check: false })).failed).toBeUndefined()

    const outputs = recordedToolOutputs(dir, readToolOutputs(outputDir(dir))!)

    expect(outputs.of(file, 'summary')).toEqual(SUMMARY)
    expect(outputs.of(file, 'declared')).toBeUndefined()
  })
})
