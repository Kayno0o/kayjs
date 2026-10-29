import { join } from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'bun:test'
import { scratchDir } from './scratch'

const ROOT = process.cwd()

async function siteFrom(env: Record<string, string>): Promise<{ site: unknown, err: string }> {
  const script = `import { siteFromEnv } from '${ROOT}/src/config-loader'\nconst first = siteFromEnv()\nsiteFromEnv()\nconsole.log(JSON.stringify(first ?? null))`
  const run = Bun.spawn([process.execPath, '-e', script], { cwd: ROOT, env: { ...process.env, SITE_URL: undefined, ORIGIN: undefined, ...env }, stdout: 'pipe', stderr: 'pipe' })
  const [out, err] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text()])

  await run.exited

  return { site: JSON.parse(out), err }
}

async function baseFrom(env: Record<string, string>, config = 'export default {}'): Promise<{ base: unknown, err: string }> {
  const dir = await scratchDir('site-base-')

  await Bun.write(join(dir, 'kay.config.ts'), config)

  const script = `import { loadConfig } from '${ROOT}/src/config-loader'\nconsole.log(JSON.stringify((await loadConfig(${JSON.stringify(dir)})).base ?? null))`
  const run = Bun.spawn([process.execPath, '-e', script], { cwd: ROOT, env: { ...process.env, SITE_BASE: undefined, ...env }, stdout: 'pipe', stderr: 'pipe' })
  const [out, err] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text()])

  await run.exited

  return { base: JSON.parse(out), err }
}

describe('the base from the environment', () => {
  it('reads SITE_BASE where the config sets no base, with or without its leading slash', async () => {
    expect(await baseFrom({ SITE_BASE: '/me/site' })).toEqual({ base: '/me/site', err: '' })
    expect(await baseFrom({ SITE_BASE: 'me/site' })).toEqual({ base: '/me/site', err: '' })
    expect(await baseFrom({ SITE_BASE: '/me/site/' })).toEqual({ base: '/me/site/', err: '' })
  })

  it('leaves the root alone for an empty or missing SITE_BASE, and lets the config\'s base win', async () => {
    expect(await baseFrom({ SITE_BASE: '' })).toEqual({ base: null, err: '' })
    expect(await baseFrom({})).toEqual({ base: null, err: '' })
    expect(await baseFrom({ SITE_BASE: '/env' }, 'export default { base: \'/config\' }')).toEqual({ base: '/config', err: '' })
  })
})

describe('the site from the environment', () => {
  it('reads SITE_URL without a word', async () => {
    expect(await siteFrom({ SITE_URL: 'https://example.com' })).toEqual({ site: 'https://example.com', err: '' })
  })

  it('reads nothing from ORIGIN or an empty SITE_URL', async () => {
    expect(await siteFrom({ ORIGIN: 'https://example.com' })).toEqual({ site: null, err: '' })
    expect(await siteFrom({ SITE_URL: '' })).toEqual({ site: null, err: '' })
  })
})
