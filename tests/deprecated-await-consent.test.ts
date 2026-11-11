import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { awaitConsent } from '../src/check/await-consent'
import { applySafeFixes } from '../src/check/fixes'
import { scratchDir } from './scratch'

async function project(files: Record<string, string>): Promise<string> {
  const root = await scratchDir('await-consent-')

  await Promise.all(Object.entries(files).map(async ([path, content]) => Bun.write(join(root, path), content)))

  return root
}

describe('deprecated-await-consent', () => {
  it('renames consent in the options of analytics() and vitals(), a shorthand included', async () => {
    const config = 'import { analytics, vitals } from \'kay/analytics\'\nimport * as stats from \'kay/analytics\'\n\nconst consent = true\n\nexport default { extensions: [\n  analytics({ provider: \'ga4\', measurementId: \'G\', apiSecret: \'s\', consent: { notice: false } }),\n  stats.analytics({ provider: \'fathom\', siteId: \'A\', \'consent\': false }),\n  vitals({ consent }),\n  vitals({ guard: false, consent: true }),\n] }\n'
    const root = await project({ 'kay.config.ts': config })

    try {
      const found = await awaitConsent(root, {})

      expect(found).toHaveLength(4)
      expect(found.every(one => one.code === 'deprecated-await-consent' && one.fixes?.[0]?.safe === true)).toBe(true)
      await applySafeFixes(root, found)
      expect(await Bun.file(join(root, 'kay.config.ts')).text()).toBe(config
        .replace('consent: { notice', 'awaitConsent: { notice')
        .replace('\'consent\': false', 'awaitConsent: false')
        .replace('vitals({ consent })', 'vitals({ awaitConsent: consent })')
        .replace('guard: false, consent: true', 'guard: false, awaitConsent: true'))
      expect(await awaitConsent(root, {})).toEqual([])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reports a key beside its new name with no fix, and leaves other calls, the signal and other options alone', async () => {
    const script = 'import { analytics, consent } from \'kay/analytics\'\nimport { analytics as other } from \'./mine\'\n\nanalytics({ provider: \'ga4\', consent: true, awaitConsent: false })\nother({ consent: true })\nfoo({ consent: true })\nanalytics({ provider: \'ga4\', info: false })\nconsent.set(\'yes\')\n'
    const root = await project({ 'src/stats.ts': script })

    try {
      const found = await awaitConsent(root, {})

      expect(found).toHaveLength(1)
      expect(found[0]!.fixes).toBeUndefined()
      expect(await awaitConsent(root, { lints: { 'deprecated-await-consent': 'allow' } })).toEqual([])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
