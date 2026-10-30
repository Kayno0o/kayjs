import { existsSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { afterAll, describe, expect, it } from 'bun:test'
import { listeningPort } from './listening'
import { fixtureCopy, scratchDir } from './scratch'

const CLI = join(import.meta.dir, '..', 'src', 'cli.ts')
const SERVER = 'import process from \'node:process\'\nimport { Elysia } from \'elysia\'\nimport { pages } from \'kay/server\'\n\nconst app = new Elysia().use(await pages()).listen(Number(process.env.PORT ?? 0))\n\nconsole.log(`listening ${app.server?.port}`)\n'
const roots: string[] = []

afterAll(async () => {
  for (const dir of roots)
    await rm(dir, { recursive: true, force: true })
})

// Compiles the mcp-key fixture with `key` and `base` in its config, in a folder of its own.
async function compile(key: string, base?: string): Promise<{ root: string, executable: string }> {
  const root = resolve(await fixtureCopy('mcp-key'))
  const executable = join(root, 'bin-server')

  roots.push(root)
  await Bun.write(join(root, 'src/server.ts'), SERVER)
  await Bun.write(join(root, 'kay.config.ts'), `import { defineConfig } from 'kay/server'\n\nexport default defineConfig({ ${base === undefined ? '' : `base: '${base}', `}mcp: { key: ${key}, rateLimit: false } })\n`)

  const child = Bun.spawn([process.execPath, CLI, 'build', root, '--no-check', '--compile', executable], { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, NODE_ENV: 'development' } })
  const [errors, code] = await Promise.all([new Response(child.stderr).text(), child.exited])

  expect({ code, errors }).toEqual({ code: 0, errors: '' })

  return { root, executable }
}

// The test run's environment without the variables that would give the key.
function environment(): Record<string, string> {
  const kept = Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined && entry[0] !== 'KAY_MCP_KEY' && entry[0] !== 'KAY_MCP_KEY_FILE')

  return { ...Object.fromEntries(kept), NODE_ENV: 'production', PORT: '0', KAY_EPHEMERAL_SECRET: '1' }
}

// Runs the executable from `cwd`, asks the endpoint for its tools with `key`, and answers the status.
async function ask(executable: string, cwd: string, key: string | undefined, path: string): Promise<number> {
  const child = Bun.spawn([executable], { cwd, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', env: environment() })

  try {
    const port = await listeningPort(child, 'the executable')
    const response = await fetch(`http://localhost:${port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...key !== undefined && { authorization: `Bearer ${key}` } }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) })

    return response.status
  }
  finally {
    child.kill()
    await child.exited
  }
}

describe('mcp.key { file } in a compiled server', () => {
  it('is made where the executable runs, not under the folder it was built in', async () => {
    const { root, executable } = await compile('{ file: \'data/mcp-key\' }')
    const cwd = resolve(await scratchDir('mcp-run-'))

    roots.push(cwd)

    expect(await ask(executable, cwd, undefined, '/mcp')).toBe(401)

    const key = (await readFile(join(cwd, 'data/mcp-key'), 'utf8')).trim()

    expect(existsSync(join(root, 'data'))).toBe(false)
    expect(await ask(executable, cwd, key, '/mcp')).toBe(200)
  }, 300_000)

  it('does the same under a base path', async () => {
    const { root, executable } = await compile('{ file: \'data/mcp-key\' }', '/app')
    const cwd = resolve(await scratchDir('mcp-run-'))

    roots.push(cwd)
    await ask(executable, cwd, undefined, '/app/mcp')

    expect(existsSync(join(cwd, 'data/mcp-key'))).toBe(true)
    expect(existsSync(join(root, 'data'))).toBe(false)
  }, 300_000)

  it('keeps an absolute file as given', async () => {
    const cwd = resolve(await scratchDir('mcp-run-'))
    const file = join(await scratchDir('mcp-abs-'), 'nested', 'key')

    roots.push(cwd, join(file, '..', '..'))

    const { executable } = await compile(`{ file: ${JSON.stringify(file)} }`)

    await ask(executable, cwd, undefined, '/mcp')

    expect(existsSync(file)).toBe(true)
    expect(existsSync(join(cwd, 'data'))).toBe(false)
  }, 300_000)
})
