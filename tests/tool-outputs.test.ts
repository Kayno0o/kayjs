import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { outputDir } from '../src/build/assets'
import { buildProject } from '../src/build/pipeline'
import { deriveToolOutputs } from '../src/check/tool-outputs'
import { loadConfig } from '../src/config-loader'
import { TOOL_OUTPUTS_RECORD } from '../src/server/tool-outputs'
import { fixtureCopy } from './scratch'

const SUMMARY = {
  type: 'object',
  properties: { count: { type: 'number' }, at: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } }, note: { type: 'string' } },
  required: ['count', 'at', 'tags'],
}

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

    expect(outputs).toEqual({ 'src/routes/index.kay#summary': SUMMARY })
  })

  it('runs no tsgo for a project with no tool action, and leaves no record', async () => {
    const dir = join(process.cwd(), await fixtureCopy('tool-outputs'))

    await Bun.write(join(dir, 'src/routes/index.kay'), '--- server\nimport { t } from \'elysia\'\nimport { action } from \'kay\'\n\nexport const hidden = action(t.Object({}), () => 1)\n---\nh1 Hi\n')
    expect(await derive(dir)).toBeUndefined()
    expect(existsSync(join(dir, '.kay', 'tool-probe'))).toBe(false)
  })

  it('goes on past a type error in the app, and keeps the tool whose type it can read', async () => {
    const dir = join(process.cwd(), await fixtureCopy('tool-outputs'))
    const file = join(dir, 'src/routes/index.kay')

    await Bun.write(file, (await Bun.file(file).text()).replace('---\nh1', 'export const broken: number = \'no\'\n---\nh1'))

    expect(await derive(dir)).toEqual({ 'src/routes/index.kay#summary': SUMMARY })
  })

  it('reads the new return type after it changed, and drops a tool that stopped being one', async () => {
    const dir = join(process.cwd(), await fixtureCopy('tool-outputs'))
    const file = join(dir, 'src/routes/index.kay')

    await derive(dir)
    await Bun.write(file, (await Bun.file(file).text()).replace('count: 2, at', 'count: \'two\', at'))

    expect(((await derive(dir))!['src/routes/index.kay#summary'] as { properties: { count: unknown } }).properties.count).toEqual({ type: 'string' })

    await Bun.write(file, (await Bun.file(file).text()).replace(', note: undefined as string | undefined }), { tool: true })', ' }), {})'))

    expect(await derive(dir)).toBeUndefined()
  })
})

describe('kay build', () => {
  it('records the schemas beside the build, with or without a check, and none for a project with no tool action', async () => {
    const dir = join(process.cwd(), await fixtureCopy('tool-outputs'))
    const config = await loadConfig(dir)
    const recorded = join(outputDir(dir), TOOL_OUTPUTS_RECORD)

    expect((await buildProject(dir, config, { check: false })).failed).toBeUndefined()
    expect((await Bun.file(recorded).json() as { outputs: object }).outputs).toEqual({ 'src/routes/index.kay#summary': SUMMARY })

    await Bun.write(join(dir, 'src/routes/index.kay'), 'h1 Hi\n')
    expect((await buildProject(dir, config, { check: false })).failed).toBeUndefined()
    expect(existsSync(recorded)).toBe(false)
    expect(existsSync(join(dir, '.kay', 'tool-probe'))).toBe(false)
  })
})
