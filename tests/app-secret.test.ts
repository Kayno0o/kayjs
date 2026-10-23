import { join } from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'bun:test'
import { scratchDir } from './scratch'

const ROOT = process.cwd()
const FIRST = 'first-secret-first-secret-first-secret'
const SECOND = 'second-secret-second-secret-second-secret'

const HEAD = `
import { Elysia } from '${ROOT}/node_modules/elysia'
import { session } from '${ROOT}/src/server/session'
import { setupStampSecret, appSecrets } from '${ROOT}/src/server/stamp'
import { setupPreview, previewUrl } from '${ROOT}/src/server/preview'
Date.now = () => 1_000_000
const signature = (secret) => { setupPreview(secret === undefined ? {} : { secret }, ''); return previewUrl('/') }
const build = (secret) => new Elysia().use(session(secret === undefined ? {} : { secret })).get('/set', async ({ session }) => { await session.set('n', 1); return 'ok' }).get('/get', async ({ session }) => String(await session.get('n') ?? 'none'))
const cookieOf = async (app) => (await app.handle(new Request('http://localhost/set'))).headers.getSetCookie().find(c => c.startsWith('kay_session=')).split(';')[0]
const read = async (app, cookie) => (await (await app.handle(new Request('http://localhost/get', { headers: { cookie } }))).text())
`

// The app's secret is process-wide state, so each case runs in a process of its own, in a folder of its own that the development secret is kept in.
async function isolated(script: string, env: Record<string, string>, cwd?: string): Promise<{ out: unknown, err: string, code: number }> {
  const folder = cwd ?? await scratchDir('app-secret')
  const clean = { ...process.env, KAY_SECRET: undefined, NODE_ENV: undefined, ...env }
  const run = Bun.spawn([process.execPath, '-e', `${HEAD}\n${script}`], { cwd: folder, env: clean, stdout: 'pipe', stderr: 'pipe' })
  const [out, err] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text()])
  const code = await run.exited

  return { out: out.trim() === '' ? undefined : JSON.parse(out.trim().split('\n').at(-1)!), err, code }
}

describe('the app secret', () => {
  it('seals a session with KAY_SECRET in production, as the same secret given to session() does', async () => {
    const { out, err } = await isolated(`
const sealed = await cookieOf(build())
console.log(JSON.stringify([await read(build(), sealed), await read(build('${FIRST}'), sealed), await read(build('${SECOND}'), sealed)]))
`, { KAY_SECRET: FIRST, NODE_ENV: 'production' })

    expect(err).not.toContain('error')
    expect(out).toEqual(['1', '1', 'none'])
  })

  it('warns in production of a secret long enough but of few different characters, in a session and in the config, and not of a random one', async () => {
    const warned = (err: string) => err.includes('fewer than 10 different characters')
    const weak = 'a'.repeat(40)
    const random = 'f3a9c1d7-52b8-4e6a-9d04-7b1c8e2a5f60'

    expect(warned((await isolated(`build('${weak}')`, { NODE_ENV: 'production' })).err)).toBe(true)
    expect(warned((await isolated(`setupStampSecret('${weak}')`, { NODE_ENV: 'production' })).err)).toBe(true)
    expect(warned((await isolated(`build('${random}')`, { NODE_ENV: 'production' })).err)).toBe(false)
    expect(warned((await isolated(`build('${weak}')`, { NODE_ENV: 'development' })).err)).toBe(false)
  })

  it('warns of a preview.secret of few different characters and refuses a short one in a list', async () => {
    const preview = async (secret: string) => isolated(`
import { setupPreview } from '${ROOT}/src/server/preview'
try {
  setupPreview({ secret: ${secret} }, '')
  console.log(JSON.stringify('set'))
}
catch (error) {
  console.log(JSON.stringify(error.message))
}
`, { NODE_ENV: 'production' })
    const random = 'f3a9c1d7-52b8-4e6a-9d04-7b1c8e2a5f60'

    expect((await preview(`'${'a'.repeat(40)}'`)).err).toContain('`preview.secret` in kay.config.ts holds a secret of fewer than 10 different characters')
    expect((await preview(`'${random}'`)).err).not.toContain('fewer than')
    expect((await preview(`['${random}', 'short']`)).out).toContain('lists a secret that is 5 characters long')
    expect((await preview(`['${random}', 5]`)).out).toContain('lists a secret that is not a string')
  })

  it('refuses to start a production server on a key of its process, unless a secret is set or an ephemeral key is asked for', async () => {
    const start = async (env: Record<string, string>, secret = '') => (await isolated(`
import { refuseProcessKey, warnOnStampKey } from '${ROOT}/src/server/stamp'
${secret}
warnOnStampKey(true)
try {
  refuseProcessKey()
  console.log(JSON.stringify('started'))
}
catch (error) {
  console.log(JSON.stringify(error.message))
}
`, { NODE_ENV: 'production', KAY_EPHEMERAL_SECRET: '', ...env })).out as string

    const refused = await start({})

    expect(refused).toContain('KAY_SECRET')
    expect(refused).toContain('KAY_EPHEMERAL_SECRET=1')
    expect(await start({ KAY_EPHEMERAL_SECRET: '1' })).toBe('started')
    expect(await start({}, `setupStampSecret('${FIRST}')`)).toBe('started')
    expect(await start({ KAY_EPHEMERAL_SECRET: 'yes' })).toContain('KAY_EPHEMERAL_SECRET=1')
  })

  it('stops the listen of a production app with no secret, and lets one with a secret or an ephemeral key through', async () => {
    const listen = async (env: Record<string, string>) => {
      const script = `
import { Elysia } from '${ROOT}/node_modules/elysia'
import { pages } from '${ROOT}/src/server'
const app = new Elysia().use(await pages({ root: '${ROOT}/tests/fixtures/production', prebuilt: false, security: false }))
try {
  app.listen(0)
  console.log(JSON.stringify('listening'))
  await app.stop()
}
catch (error) {
  console.log(JSON.stringify(error.message))
}
process.exit(0)
`
      const run = Bun.spawn([process.execPath, '-e', script], { cwd: join(ROOT, 'tests/fixtures/production'), env: { ...process.env, KAY_SECRET: undefined, NODE_ENV: 'production', KAY_EPHEMERAL_SECRET: '', ...env }, stdout: 'pipe', stderr: 'ignore' })
      const out = await new Response(run.stdout).text()

      await run.exited

      return JSON.parse(out.trim().split('\n').at(-1)!) as string
    }

    expect(await listen({})).toContain('KAY_EPHEMERAL_SECRET=1')
    expect(await listen({ KAY_EPHEMERAL_SECRET: '1' })).toBe('listening')
    expect(await listen({ KAY_SECRET: FIRST })).toBe('listening')
  })

  it('takes `secret` in kay.config.ts over KAY_SECRET', async () => {
    const { out } = await isolated(`
setupStampSecret('${SECOND}')
const sealed = await cookieOf(build())
console.log(JSON.stringify([await read(build('${SECOND}'), sealed), await read(build('${FIRST}'), sealed)]))
`, { KAY_SECRET: FIRST, NODE_ENV: 'production' })

    expect(out).toEqual(['1', 'none'])
  })

  it('refuses a session with no secret anywhere in production, naming where it goes', async () => {
    const { out, err, code } = await isolated(`
try {
  build()
}
catch (error) {
  console.log(JSON.stringify(error.message))
}
`, { NODE_ENV: 'production' })

    expect(code).toBe(0)
    expect(err).toBe('')
    expect(out).toContain('session() has no secret')
    expect(out).toContain('KAY_SECRET')
  })

  it.each([
    ['KAY_SECRET', 'KAY_SECRET', { KAY_SECRET: 'too-short' }, 'build()'],
    ['KAY_SECRET read by setup', 'KAY_SECRET', { KAY_SECRET: 'too-short' }, 'setupStampSecret(undefined)'],
    ['`secret` in the config', 'kay.config.ts', {}, 'setupStampSecret(\'too-short\')'],
    ['a secret in the list', 'at least 32', { KAY_SECRET: `${FIRST},too-short` }, 'build()'],
  ])('refuses a short %s', async (_name, message, env, call) => {
    const { out } = await isolated(`
try {
  ${call}
  console.log(JSON.stringify('built'))
}
catch (error) {
  console.log(JSON.stringify(error.message))
}
`, { ...env, NODE_ENV: 'production' })

    expect(out).toContain(message)
  })

  it('treats an empty KAY_SECRET as none', async () => {
    const { out } = await isolated(`
try {
  build()
}
catch (error) {
  console.log(JSON.stringify(error.message))
}
`, { KAY_SECRET: '', NODE_ENV: 'production' })

    expect(out).toContain('session() has no secret')
  })

  it('rotates: the first of the list seals, every one opens, and the default session follows', async () => {
    const { out } = await isolated(`
const old = await cookieOf(build('${FIRST}'))
const rotated = build()
const fresh = await cookieOf(rotated)
console.log(JSON.stringify([await read(rotated, old), await read(build('${SECOND}'), fresh), await read(build('${FIRST}'), fresh), JSON.stringify(appSecrets())]))
`, { KAY_SECRET: `${SECOND}, ${FIRST}`, NODE_ENV: 'production' })

    expect(out).toEqual(['1', '1', 'none', JSON.stringify([SECOND, FIRST])])
  })

  it('derives a secret in development and under test that stays the same across restarts, and differs per checkout', async () => {
    const folder = await scratchDir('app-secret-dev')
    const script = `
const sealed = process.argv[1] === undefined ? await cookieOf(build()) : undefined
console.log(JSON.stringify(sealed))
`
    const first = await isolated(script, { NODE_ENV: 'development' }, folder)
    const again = await isolated(`
const cookie = ${JSON.stringify(first.out)}
console.log(JSON.stringify(await read(build(), cookie)))
`, { NODE_ENV: 'development' }, folder)
    const elsewhere = await isolated(`
console.log(JSON.stringify(await read(build(), ${JSON.stringify(first.out)})))
`, { NODE_ENV: 'development' }, await scratchDir('app-secret-dev-other'))

    expect(again.out).toBe('1')
    expect(elsewhere.out).toBe('none')
    expect(await Bun.file(join(folder, '.kay', 'dev-secret')).exists()).toBe(true)

    const test = await isolated(`console.log(JSON.stringify(await read(build(), ${JSON.stringify(first.out)})))`, { NODE_ENV: 'test' }, folder)

    expect(test.out).toBe('1')
  })

  it('derives none outside development and test, so a script of no mode asks for the secret', async () => {
    const { out } = await isolated(`
try {
  build()
}
catch (error) {
  console.log(JSON.stringify(error.message))
}
`, { NODE_ENV: 'staging' })

    expect(out).toContain('session() has no secret')
  })

  it('gives preview a key of its own from the app secret, never the session\'s', async () => {
    const { out } = await isolated(`
setupStampSecret(undefined)
const own = signature()
console.log(JSON.stringify([own === signature(), own !== signature('${FIRST}')]))
`, { KAY_SECRET: FIRST, NODE_ENV: 'production' })

    expect(out).toEqual([true, true])
  })

  it('refuses a preview with no secret of its own and none of the app in production, and takes the derived one in development', async () => {
    const production = await isolated(`
setupStampSecret(undefined)
try {
  setupPreview({}, '')
  console.log(JSON.stringify('set'))
}
catch (error) {
  console.log(JSON.stringify(error.message))
}
`, { NODE_ENV: 'production' })
    const development = await isolated(`
setupStampSecret(undefined)
console.log(JSON.stringify(signature().includes('kay_') || signature().length > 10))
`, { NODE_ENV: 'development' })

    expect(production.out).toContain('preview in kay.config.ts')
    expect(production.out).toContain('KAY_SECRET')
    expect(development.out).toBe(true)
  })

  it('keeps a preview.secret that is given', async () => {
    const { out } = await isolated(`
setupStampSecret(undefined)
const given = signature('${SECOND}')
setupPreview({ secret: '${SECOND}' }, '')
console.log(JSON.stringify(given === previewUrl('/')))
`, { KAY_SECRET: FIRST, NODE_ENV: 'production' })

    expect(out).toBe(true)
  })
})
