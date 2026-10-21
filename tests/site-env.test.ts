import process from 'node:process'
import { describe, expect, it } from 'bun:test'

const ROOT = process.cwd()

// The warning is told once per process, so each case runs in a process of its own.
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

  it('still reads ORIGIN, telling once that it is deprecated', async () => {
    const { site, err } = await siteFrom({ ORIGIN: 'https://example.com' })

    expect(site).toBe('https://example.com')
    expect(err.match(/set SITE_URL/g)).toHaveLength(1)
  })

  it('takes SITE_URL over ORIGIN and says nothing of an ORIGIN it did not use or that is no origin', async () => {
    expect(await siteFrom({ SITE_URL: 'https://example.com', ORIGIN: 'https://other.example' })).toEqual({ site: 'https://example.com', err: '' })
    expect(await siteFrom({ ORIGIN: 'null' })).toEqual({ site: null, err: '' })
  })
})
