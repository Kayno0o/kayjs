import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { analyticsOptions } from '../src/check/analytics-options'
import { applySafeFixes } from '../src/check/fixes'
import { scratchDir } from './scratch'

async function project(files: Record<string, string>): Promise<string> {
  const root = await scratchDir('analytics-options-')

  await Promise.all(Object.entries(files).map(async ([path, content]) => Bun.write(join(root, path), content)))

  return root
}

describe('deprecated-analytics-options', () => {
  it('renames host, policyUrl, domain and hostname in the options of analytics(), shorthands included', async () => {
    const config = 'import { analytics } from \'kay/analytics\'\nimport * as stats from \'kay/analytics\'\n\nconst host = \'https://p.example\'\nconst policyUrl = \'/privacy\'\n\nexport default { extensions: [\n  analytics({ provider: \'plausible\', domain: \'example.com\', host, policyUrl }),\n  stats.analytics({ provider: \'simpleanalytics\', hostname: \'example.com\', \'host\': \'https://q.example\' }),\n  analytics({ provider: \'matomo\', siteId: 1, host: \'https://m.example\' }),\n  analytics({ provider: \'umami\', websiteId: \'w\', url: \'https://u.example\', privacy: \'/privacy\' }),\n] }\n'
    const page = '---\nimport { analytics } from \'kay/analytics\'\n\nexport const ext = analytics({ provider: \'ga4\', measurementId: \'G-ABC123\', apiSecret: \'s\', host: \'https://g.example\' })\n---\np hi\n'
    const root = await project({ 'kay.config.ts': config, 'src/routes/page.kay': page })

    try {
      const found = await analyticsOptions(root, {})

      expect(found).toHaveLength(7)
      expect(found.every(one => one.code === 'deprecated-analytics-options' && one.fixes?.[0]?.safe === true)).toBe(true)
      await applySafeFixes(root, found)
      expect(await Bun.file(join(root, 'kay.config.ts')).text()).toBe(config
        .replace('domain: \'example.com\', host, policyUrl', 'site: \'example.com\', url: host, privacy: policyUrl')
        .replace('hostname: \'example.com\', \'host\':', 'site: \'example.com\', url:')
        .replace('host: \'https://m.example\'', 'url: \'https://m.example\''))
      expect(await Bun.file(join(root, 'src/routes/page.kay')).text()).toBe(page.replace('host:', 'url:'))
      expect(await analyticsOptions(root, {})).toEqual([])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reports a key beside its new name, and a domain with no literal provider, with no fix', async () => {
    const script = 'import { analytics } from \'kay/analytics\'\nimport { analytics as other } from \'./mine\'\n\nconst provider = \'plausible\'\n\nanalytics({ provider: \'plausible\', host: \'https://a.example\', url: \'https://b.example\' })\nanalytics({ provider, domain: \'example.com\' })\nother({ provider: \'plausible\', host: \'x\' })\nfoo({ host: \'x\' })\n'
    const root = await project({ 'src/stats.ts': script })

    try {
      const found = await analyticsOptions(root, {})

      expect(found).toHaveLength(1)
      expect(found[0]!.fixes).toBeUndefined()
      expect(await analyticsOptions(root, { lints: { 'deprecated-analytics-options': 'allow' } })).toEqual([])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
