import type { TestPage, TestSite } from '../src/test'
import process from 'node:process'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { browserPath, testSite } from '../src/test'

const path = browserPath()

// A French page holds U+00A0 before `:` and U+202F before `;`, which a test types as plain spaces.
const FRENCH = 'Raté : c’était B ; « oui »'

// CI installs Chromium for these: there, a missing browser fails rather than skipping.
describe.skipIf(path === undefined && (process.env.CI ?? '') === '')('waitFor text on a page with non-breaking spaces', () => {
  let site: TestSite
  let view: TestPage

  beforeAll(async () => {
    site = await testSite({ root: 'tests/fixtures/title', browser: { path } })
    view = await site.open('/')
    await view.evaluate((text: string) => {
      const verdict = document.createElement('p')

      verdict.className = 'verdict'
      verdict.textContent = text
      document.body.append(verdict)
    }, FRENCH)
  }, 60_000)

  afterAll(async () => site?.close())

  it('matches text typed with plain spaces, and text typed with the non-breaking ones', async () => {
    await view.waitFor('.verdict', { text: 'Raté : c’était B ; « oui »', timeout: '1000ms' })
    await view.waitFor('.verdict', { text: FRENCH, timeout: '1000ms' })
    await view.waitFor('.verdict', { text: 'B ; « oui', timeout: '1000ms' })
  })

  it('still fails on a different text, and says when only the whitespace differs', async () => {
    await expect(view.waitFor('.verdict', { text: 'Raté : c’était C', timeout: '300ms' })).rejects.not.toThrow('whitespace')
    await view.evaluate(() => {
      document.querySelector('.verdict')!.textContent = 'Raté : c’était B'
    })
    await expect(view.waitFor('.verdict', { text: 'Raté : c’était B', timeout: '300ms' })).rejects.toThrow('holds the text up to its whitespace')
  })
})
