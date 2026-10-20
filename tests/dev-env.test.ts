import type { Subprocess } from 'bun'
import { existsSync, readFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'bun:test'
import { scratchDir } from './scratch'

const CLI = join(import.meta.dir, '../src/cli.ts')

async function until(condition: () => boolean | Promise<boolean>, timeout = 20_000) {
  for (const start = Date.now(); !await condition(); await Bun.sleep(20)) {
    if (Date.now() - start > timeout)
      throw new Error('timed out')
  }
}

function freePort(): number {
  const probe = Bun.listen({ hostname: 'localhost', port: 0, socket: { data: () => undefined } })
  const { port } = probe

  probe.stop(true)

  return port
}

function lines(file: string): string[] {
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : []
}

// The variables the test reads, as each process of `kay dev` sees them.
const KEYS = ['A', 'B', 'C', 'KAY_ENV_SHELL', 'KAY_ENV_PUB']

// A project run by the real command from its own directory, so Bun loads the project's `.env` files into `kay dev` itself as for `bun run dev`.
// The server writes the variables it sees whenever it starts, the config what each process loading it sees, tagged with the script of the process.
async function running(env: Record<string, string>, shell: Record<string, string> = {}, more: Record<string, string> = {}) {
  const root = await scratchDir('dev-env-')
  const port = freePort()
  const seen = join(root, '.seen')
  const configured = join(root, '.configured')
  const read = `JSON.stringify(Object.fromEntries(${JSON.stringify(KEYS)}.map(key => [key, process.env[key]])))`

  await Bun.write(join(root, 'src/server.ts'), `import { Elysia } from 'elysia'\nimport { appendFileSync } from 'node:fs'\nimport { pages } from 'kay/server'\n\nappendFileSync(${JSON.stringify(seen)}, \`\${${read}}\\n\`)\nexport const app = new Elysia().use(await pages()).listen(Number(process.env.PORT))\n`)
  await Bun.write(join(root, 'src/routes/index.kay'), 'h1 Home\n')
  await Bun.write(join(root, 'kay.config.ts'), `import { t } from 'elysia'\nimport { appendFileSync } from 'node:fs'\nimport { basename } from 'node:path'\nimport { defineConfig } from 'kay/server'\n\nappendFileSync(${JSON.stringify(configured)}, \`\${basename(process.argv[1] ?? '')} \${${read}}\\n\`)\nexport default defineConfig({ publicEnv: t.Object({ KAY_ENV_PUB: t.String({ default: '' }) }) })\n`)
  await Promise.all(Object.entries(more).map(async ([file, content]) => Bun.write(join(root, file), content)))
  await Bun.write(join(root, '.env'), `${Object.entries(env).map(([key, value]) => `${key}=${value}`).join('\n')}\n`)
  const child: Subprocess = Bun.spawn([process.execPath, CLI, 'dev', '--port', String(port)], { cwd: root, env: { ...process.env, ...shell }, stdout: 'ignore', stderr: 'ignore' })
  const starts = () => lines(seen).map(line => JSON.parse(line) as Record<string, string | null>)
  // What the last process loading the config under `script` saw.
  const configSaw = (script: string) => {
    const last = lines(configured).filter(line => line.startsWith(`${script} `)).at(-1)

    return last === undefined ? undefined : JSON.parse(last.slice(script.length + 1)) as Record<string, string | null>
  }

  await until(() => starts().length > 0)

  return {
    root,
    port,
    starts,
    configSaw,
    configLoads: () => lines(configured).length,
    // Empty while the server is down between two processes.
    envJs: async () => {
      try {
        return await (await fetch(`http://localhost:${port}/_kay/env.js`)).text()
      }
      catch {
        return ''
      }
    },
    write: async (file: string, content: string) => Bun.write(join(root, file), content),
    cleanup: async () => {
      child.kill('SIGINT')
      await child.exited
      await rm(root, { recursive: true, force: true })
    },
  }
}

describe.concurrent('kay dev .env values', () => {
  it('follows a plain value edited, a value added and a value removed', async () => {
    const project = await running({ A: 'one' })

    try {
      expect(project.starts().at(-1)!.A).toBe('one')

      await project.write('.env', 'A=two\nB=added\n')
      await until(() => project.starts().at(-1)!.B === 'added')
      expect(project.starts().at(-1)!.A).toBe('two')

      await project.write('.env', 'B=added\n')
      await until(() => project.starts().at(-1)!.A === undefined)
      expect(project.starts().at(-1)!.B).toBe('added')
    }
    finally {
      await project.cleanup()
    }
  }, 60_000)

  it('follows a value expanding the shell\'s variables or another key of the file, whose source changes', async () => {
    const project = await running({ A: '${HOME}/x1', B: '${USER_PART}-${A}' }, { USER_PART: 'part' })

    try {
      const home = process.env.HOME!

      expect(project.starts().at(-1)!.A).toBe(`${home}/x1`)
      expect(project.starts().at(-1)!.B).toBe(`part-${home}/x1`)

      await project.write('.env', 'A=${HOME}/x2\nB=${USER_PART}-${A}\n')
      await until(() => project.starts().at(-1)!.A === `${home}/x2`)
      expect(project.starts().at(-1)!.B).toBe(`part-${home}/x2`)
    }
    finally {
      await project.cleanup()
    }
  }, 60_000)

  it('keeps a value the shell set over the file, and a file one changing under it', async () => {
    const project = await running({ KAY_ENV_SHELL: 'file', A: 'one' }, { KAY_ENV_SHELL: 'shell' })

    try {
      await project.write('.env', 'KAY_ENV_SHELL=other\nA=two\n')
      await until(() => project.starts().at(-1)!.A === 'two')
      expect(project.starts().at(-1)!.KAY_ENV_SHELL).toBe('shell')
    }
    finally {
      await project.cleanup()
    }
  }, 60_000)

  it('reads .env.local and the mode file over .env', async () => {
    const project = await running({ A: 'base', B: 'base' }, {}, { '.env.local': 'A=local\n', '.env.development': 'A=mode\nB=mode\n' })

    try {
      // Bun's order: .env.local over .env.development over .env.
      expect(project.starts().at(-1)!.A).toBe('local')
      expect(project.starts().at(-1)!.B).toBe('mode')

      await project.write('.env.local', 'A=local2\n')
      await until(() => project.starts().at(-1)!.A === 'local2')

      await project.write('.env.development', 'A=mode\nB=mode2\n')
      await until(() => project.starts().at(-1)!.B === 'mode2')
    }
    finally {
      await project.cleanup()
    }
  }, 60_000)

  it('shows the process writing the types, which loads the config, the new value', async () => {
    const project = await running({ C: 'c1' })

    try {
      await until(() => project.configSaw('types.ts')?.C === 'c1')

      await project.write('.env', 'C=c2\n')
      await until(() => project.starts().at(-1)!.C === 'c2')
      await until(() => project.configSaw('types.ts')?.C === 'c2')

      await project.write('.env', 'C=c3\n')
      await until(() => project.configSaw('types.ts')?.C === 'c3')

      await project.write('.env', 'C=\n')
      await until(() => project.configSaw('types.ts')?.C === '')
    }
    finally {
      await project.cleanup()
    }
  }, 60_000)

  it('shows the browser the new value through /_kay/env.js', async () => {
    const project = await running({ KAY_ENV_PUB: 'p1' })

    try {
      await until(async () => (await project.envJs()).includes('p1'))

      await project.write('.env', 'KAY_ENV_PUB=p2\n')
      await until(async () => (await project.envJs()).includes('p2'))
      expect(await project.envJs()).not.toContain('p1')
    }
    finally {
      await project.cleanup()
    }
  }, 60_000)

  it('restarts nothing for a .env written again with the same content', async () => {
    const project = await running({ A: 'one' })

    try {
      await project.write('.env', 'A=two\n')
      await until(() => project.starts().at(-1)!.A === 'two')
      await until(() => project.configSaw('types.ts')?.A === 'two')
      await Bun.sleep(1000)

      const starts = project.starts().length
      const loads = project.configLoads()

      await project.write('.env', 'A=two\n')
      await Bun.sleep(1500)

      expect(project.starts()).toHaveLength(starts)
      expect(project.configLoads()).toBe(loads)
    }
    finally {
      await project.cleanup()
    }
  }, 60_000)
})
