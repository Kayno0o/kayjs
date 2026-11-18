import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'bun:test'
import { listEnv } from '../src/commands/env'
import { buildingWithoutEnv, listingEnv, recordEnv } from '../src/server/env-state'
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
    const root = await project({ 'kay.config.ts': 'export default { assets: { favicon: false }, metrics: true, proxy: { key: { header: "x-key" } }, mcp: { token: true } }\n' })

    buildingWithoutEnv()

    const { variables } = await listEnv(root)
    const kays = variables.filter(({ source }) => source === 'kay').map(({ name }) => name)

    expect(kays.length).toBeGreaterThan(4)
    expect(kays.filter(name => !name.startsWith('KAY_') && !HOST_SET.has(name))).toEqual([])
  })
})

describe('the variables of one project\'s listing', () => {
  const env = (name: string) => `import { s } from 'kay'\nimport { defineEnv } from 'kay/server'\n\nexport const env = defineEnv(s.Object({ ${name}: s.String() }))\n`

  it('leave out another project of the process, and a project nested in this one', async () => {
    buildingWithoutEnv()

    const first = await project({ 'kay.config.ts': 'import \'./src/env\'\nexport default { assets: { favicon: false } }\n', 'src/env.ts': env('FIRST_ONLY') })
    const second = await project({
      'kay.config.ts': 'import \'./inner/src/env\'\nexport default { assets: { favicon: false } }\n',
      'inner/kay.config.ts': 'export default {}\n',
      'inner/src/env.ts': env('INNER_ONLY'),
      'src/env.ts': env('SECOND_ONLY'),
    })
    const names = async (root: string) => (await listEnv(root)).variables.map(({ name }) => name)

    expect(await names(first)).toContain('FIRST_ONLY')
    expect(await names(second)).toContain('SECOND_ONLY')
    expect(await names(second)).not.toContain('FIRST_ONLY')
    expect(await names(second)).not.toContain('INNER_ONLY')
  })

  it('drop a call a module made again at the same place with another schema', () => {
    buildingWithoutEnv()
    listingEnv().length = 0

    let calls = 0
    // Not a tail call, which the engine leaves out of the stack.
    const declare = (name: string) => {
      recordEnv({ properties: { [name]: {} } }, declare)
      calls++
    }

    for (const name of ['OLD_NAME', 'NEW_NAME'])
      declare(name)

    expect(calls).toBe(2)
    expect(listingEnv().map(({ schema }) => Object.keys(schema.properties))).toEqual([['NEW_NAME']])
  })
})

const READ = /\b(?:process|Bun)\.env(?:\.([A-Za-z_]\w*)|\[\s*['"]([A-Za-z_]\w*)['"]\s*\])/g
const SCHEMA_KEY = /^\s*([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+):\s*s\.(?:Optional|String|Boolean|Integer|Public|Secret)\(/gm
const ROOT = join(import.meta.dir, '..')
const ANY = new Set(['NODE_ENV'])
// What a host, the OS or a tool sets, or the app's own name in a template string, which kay reads without owning.
const FOREIGN = new Set(['BROWSER', 'CI', 'DATABASE_URL', 'FORCE_COLOR', 'GITHUB_WORKSPACE', 'HOST', 'LOCALAPPDATA', 'MIGRATE_DATABASE_URL', 'NODE_PORT', 'NO_COLOR', 'PATH', 'PLAYWRIGHT_BROWSERS_PATH', 'PORT', 'SHELL', 'SITE_BASE', 'SITE_URL', 'TRACKER_PASSWORD', 'TRACKER_USER', 'UMAMI_HOST', 'VAPID_PRIVATE_KEY', 'VAPID_PUBLIC_KEY', 'X', 'XDG_CONFIG_HOME'])
const BUN = /^BUN_/
const VENDOR = new Set(['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'])
// kayjs-ai's switch for its own tests, read where `ask` picks a provider.
const TEST_SWITCH = new Set(['KAYJS_AI_REAL_PROVIDERS'])

const SCANNED: { root: string, allowed: (name: string) => boolean }[] = [
  { root: 'src', allowed: name => name.startsWith('KAY_') || FOREIGN.has(name) || BUN.test(name) },
  { root: 'packages/auth/src', allowed: name => name.startsWith('AUTH_') },
  { root: 'packages/mail/src', allowed: name => name.startsWith('MAIL_') },
  { root: 'packages/ai/src', allowed: name => name.startsWith('AI_') || VENDOR.has(name) || TEST_SWITCH.has(name) },
  { root: 'packages/cms/src', allowed: name => name.startsWith('CMS_') },
  { root: 'packages/ui/src', allowed: () => false },
]

// Every name a source tree reads from the environment or declares in a schema, with the file.
async function namesIn(root: string): Promise<{ name: string, file: string }[]> {
  const found: { name: string, file: string }[] = []

  for (const file of new Bun.Glob('**/*.{ts,tsx,kay}').scanSync(join(ROOT, root))) {
    const text = await Bun.file(join(ROOT, root, file)).text()

    for (const match of text.matchAll(READ))
      found.push({ name: (match[1] ?? match[2])!, file: `${root}/${file}` })

    for (const match of text.matchAll(SCHEMA_KEY))
      found.push({ name: match[1]!, file: `${root}/${file}` })
  }

  return found
}

describe('every variable the source reads', () => {
  for (const { root, allowed } of SCANNED) {
    it(`follows the rule in ${root}`, async () => {
      const broken = (await namesIn(root)).filter(({ name }) => !ANY.has(name) && !allowed(name))

      expect(broken).toEqual([])
    })
  }

  it('spells the insecure flag <PREFIX>_INSECURE as an optional boolean in kayjs-mail and kayjs-ai', async () => {
    for (const [prefix, file] of [['MAIL', 'packages/mail/src/mailer.ts'], ['AI', 'packages/ai/src/config.ts']] as const)
      expect(await Bun.file(join(ROOT, file)).text()).toContain(`${prefix}_INSECURE: s.boolean({ optional: true`)
  })
})
