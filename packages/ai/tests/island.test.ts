import { cp, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { expect, test } from 'bun:test'
import { scratchDir } from '../../../tests/scratch'

const CLI = join(import.meta.dir, '../../../src/cli.ts')
const SERVER = '--- server\nimport { ask } from \'@kaynooo/kayjs-ai\'\n\nconst answer = ask(\'hi\')\n---\nawait answer\n  p Thinking\nthen text\n  p {text}\n'
const ISLAND = '---\nimport { ask } from \'@kaynooo/kayjs-ai\'\n\nlet text = \'\'\n\nasync function go() {\n  text = await ask(\'hi\')\n}\n---\nbutton(onClick={go}) Ask\np {text}\n'

async function build(page: string): Promise<{ code: number, output: string }> {
  const dir = await scratchDir('ai-island-')

  await mkdir(join(dir, 'src/routes'), { recursive: true })
  await cp(join(import.meta.dir, 'fixture/tsconfig.json'), join(dir, 'tsconfig.json'))
  await Bun.write(join(dir, 'kay.config.ts'), 'import { defineConfig } from \'kay/server\'\n\nexport default defineConfig({})\n')
  await Bun.write(join(dir, 'src/routes/index.kay'), page)

  const run = Bun.spawn([process.execPath, CLI, 'build'], { cwd: dir, stdout: 'pipe', stderr: 'pipe' })
  const output = await new Response(run.stdout).text() + await new Response(run.stderr).text()

  return { code: await run.exited, output }
}

// The key is read where the server runs: an island importing ask would ship the module reading it to the browser, which the build refuses.
test('a page asking in its server fence builds, and an island importing ask does not', async () => {
  const server = await build(SERVER)

  expect(server.output).not.toContain('Browser build cannot import')
  expect(server.code).toBe(0)

  const island = await build(ISLAND)

  expect(island.code).not.toBe(0)
  expect(island.output).toContain('Browser build cannot import')
}, 120_000)
