import { afterAll, describe, expect, it } from 'bun:test'
import { testSite } from '../src/test'
import { fixtureCopy } from './scratch'

const SETTINGS = /^const KAY = (.+)$/m
const root = await fixtureCopy('bare')
const sites = [
  await testSite({ root, islands: false, offline: true }),
  await testSite({ root, offline: { pages: ['/'], fallback: '/' } }),
]

afterAll(async () => {
  await Promise.all(sites.map(async site => site.close()))
})

describe('testSite on an offline app that kay build never ran for', () => {
  it('answers /sw.js with a worker listing no build files, with and without islands checked', async () => {
    for (const site of sites) {
      const response = await site.fetch('/sw.js')

      expect(response.status).toBe(200)
      expect((JSON.parse(SETTINGS.exec(await response.text())![1]!) as { files: string[] }).files).toEqual([])
    }
  })
})
