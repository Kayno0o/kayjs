import type { PagesOptions } from '../src/server/app'
import type { ClientBuild } from '../src/server/client'
import { describe, expect, it } from 'bun:test'
import { resolveProject } from '../src/project'
import { servePages } from '../src/server/app'

const routes = 'tests/fixtures/i18n/src/routes'
const i18n = { locales: ['fr', 'en'], defaultLocale: 'fr', messages: 'tests/fixtures/i18n/src/messages' }

// Serves `options` with a client loader that only counts, answering how many builds the server started and what it refused with.
async function refusal(options: PagesOptions): Promise<{ builds: number, message: string }> {
  let builds = 0
  const project = resolveProject(process.cwd(), { routes, prebuilt: false, security: false, ...options }, { dev: false, prebuilt: false, underKayDev: false })
  const loadClient = (): ClientBuild => {
    builds++

    throw new Error('a build started')
  }

  try {
    await servePages(project, loadClient)
  }
  catch (error) {
    return { builds, message: (error as Error).message }
  }

  throw new Error('the config was not refused')
}

describe('a refused config', () => {
  it.each([
    ['images.maxDensity', { images: { maxDensity: 0.5 } }, 'images.maxDensity is 0.5'],
    ['markdown.readingSpeed', { markdown: { readingSpeed: 0 } }, 'readingSpeed'],
    ['an i18n locale with no messages', { i18n: { ...i18n, locales: ['fr', 'de'] } }, 'so its messages go in'],
  ] as [string, PagesOptions, string][])('starts no client build: %s', async (_, options, message) => {
    const refused = await refusal(options)

    expect(refused.message).toContain(message)
    expect(refused.builds).toBe(0)
  })
})
