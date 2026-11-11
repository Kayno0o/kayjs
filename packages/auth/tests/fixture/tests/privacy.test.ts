import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

interface Shown {
  notice: string | null
  links: string[][]
}

// One process per run: the fixture's auth reads FIXTURE_PRIVACY when it loads.
async function shown(privacy?: object): Promise<Record<'en' | 'fr', Shown>> {
  const env = { ...process.env, ...privacy && { FIXTURE_PRIVACY: JSON.stringify(privacy) } }
  const run = Bun.spawn([process.execPath, join(import.meta.dir, 'privacy.ts')], { env, stdout: 'pipe', stderr: 'pipe' })

  try {
    const printed = await new Response(run.stdout).text()

    expect(await run.exited).toBe(0)

    return JSON.parse(printed.split('\n').findLast(line => line.startsWith('{'))!) as Record<'en' | 'fr', Shown>
  }
  finally {
    run.kill()
  }
}

describe('the register page\'s purpose line and privacy link', () => {
  test('draws nothing without the options', async () => {
    const found = await shown()

    expect(found.en.notice).toBeNull()
    expect(found.fr.notice).toBeNull()
  }, 60_000)

  test('links the privacy page after the stock line, worded in the locale', async () => {
    const found = await shown({ privacy: '/privacy' })

    expect(found.en.notice).toBe('We use your email address to create and secure your account. Privacy policy')
    expect(found.en.links).toEqual([['Privacy policy', '/privacy', 'noopener noreferrer']])
    expect(found.fr.notice).toContain('Politique de confidentialité')
  }, 60_000)

  test('draws the app\'s own purpose in place of the stock line, with or without the link', async () => {
    const found = await shown({ purpose: 'Your address signs you in.' })
    const linked = await shown({ purpose: 'Your address signs you in.', privacy: 'https://example.test/privacy' })

    expect(found.en.notice).toBe('Your address signs you in.')
    expect(found.en.links).toEqual([])
    expect(linked.en.notice).toBe('Your address signs you in. Privacy policy')
    expect(linked.en.links[0]![1]).toBe('https://example.test/privacy')
  }, 60_000)
})
