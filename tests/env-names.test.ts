import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { afterAll, describe, expect, it } from 'bun:test'
import { listEnv } from '../src/commands/env'
import { RENAMED_ENV, renamedProblems } from '../src/commands/env-compare'
import { buildingWithoutEnv } from '../src/server/env-state'
import { scratchDir } from './scratch'

const dirs: string[] = []

afterAll(async () => {
  await Promise.all(dirs.map(async dir => rm(dir, { recursive: true, force: true })))
})

async function project(files: Record<string, string>): Promise<string> {
  const root = await scratchDir('env-names-')

  dirs.push(root)
  await Promise.all(Object.entries(files).map(async ([path, content]) => Bun.write(join(root, path), content)))

  return root
}

// The rule of llms/environment.md: kay's own start KAY_, apart from the names a host sets for the app.
const HOST_SET = new Set(['PORT', 'HOST', 'SITE_URL', 'SITE_BASE'])

describe('environment variable names', () => {
  it('start KAY_ for every variable kay reads, apart from the ones a host sets', async () => {
    const root = await project({ 'kay.config.ts': 'export default { favicon: false, metrics: true, proxy: { key: "x-key" }, mcp: { key: true } }\n' })

    buildingWithoutEnv()

    const { variables } = await listEnv(root)
    const kays = variables.filter(({ source }) => source === 'kay').map(({ name }) => name)

    expect(kays.length).toBeGreaterThan(4)
    expect(kays.filter(name => !name.startsWith('KAY_') && !HOST_SET.has(name))).toEqual([])
  })

  it('has no renamed variable listed under its old name', () => {
    expect(Object.values(RENAMED_ENV).every(name => (/^(?:AUTH|MAIL|AI|CMS)_/).test(name))).toBe(true)
  })
})

describe('kay env on a renamed variable', () => {
  it('warns for an old name in the environment, a compose file or the example file', async () => {
    const root = await project({
      'compose.yaml': 'services:\n  app:\n    image: x\n    environment:\n      MAIL_INBOUND_SECRET: abc\n',
      '.env.example': 'KAYJS_AUTH_DATABASE_URL=\n',
    })
    const saved = process.env.MAIL_INBOUND_SECRET

    process.env.MAIL_INBOUND_SECRET = 'abc'

    try {
      const { compareEnv } = await import('../src/commands/env-compare')
      const found = (await compareEnv(root, [], { compose: ['compose.yaml'], example: '.env.example' })).filter(({ severity }) => severity === 'warning').map(({ message }) => message)

      expect(found.filter(message => message.startsWith('MAIL_INBOUND_SECRET is now MAIL_EVENTS_INBOUND'))).toHaveLength(2)
      expect(found.filter(message => message.startsWith('KAYJS_AUTH_DATABASE_URL is now AUTH_DATABASE_URL'))).toHaveLength(1)
      expect(renamedProblems(root, new Map(), undefined, undefined).map(({ message }) => message)).toEqual([expect.stringContaining('MAIL_INBOUND_SECRET is now MAIL_EVENTS_INBOUND')])
    }
    finally {
      if (saved === undefined)
        delete process.env.MAIL_INBOUND_SECRET
      else
        process.env.MAIL_INBOUND_SECRET = saved
    }
  })
})
