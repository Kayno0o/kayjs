import process from 'node:process'
import { describe, expect, it } from 'bun:test'

const ROOT = process.cwd()

async function siteFrom(env: Record<string, string>): Promise<{ site: unknown, err: string }> {
  const script = `import { siteFromEnv } from '${ROOT}/src/config'\nconst first = siteFromEnv()\nsiteFromEnv()\nconsole.log(JSON.stringify(first ?? null))`
  const run = Bun.spawn([process.execPath, '-e', script], { cwd: ROOT, env: { ...process.env, SITE_URL: undefined, ORIGIN: undefined, ...env }, stdout: 'pipe', stderr: 'pipe' })
  const [out, err] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text()])

  await run.exited

  return { site: JSON.parse(out), err }
}

describe('the site from the environment', () => {
  it('reads SITE_URL without a word', async () => {
    expect(await siteFrom({ SITE_URL: 'https://example.com' })).toEqual({ site: 'https://example.com', err: '' })
  })

  it('reads nothing from ORIGIN or an empty SITE_URL', async () => {
    expect(await siteFrom({ ORIGIN: 'https://example.com' })).toEqual({ site: null, err: '' })
    expect(await siteFrom({ SITE_URL: '' })).toEqual({ site: null, err: '' })
  })
})
