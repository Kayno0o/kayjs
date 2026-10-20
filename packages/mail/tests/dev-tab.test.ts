import type { TestPage } from 'kay/test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { browse, browserPath } from 'kay/test'
import { devApp } from './helpers/dev'

const path = browserPath()

// The subjects the Mail tab of the dev tool lists, newest first, read in the page.
function listed(): string[] {
  const root = document.querySelector('kay-dev')!.shadowRoot!

  return [...root.querySelectorAll('#kay-dev-mail .row button.link')].map(button => button.textContent)
}

// Opens a tab of the dev tool once it is there: the libraries' tabs come a moment after a page loads.
function openTab(id: string): boolean {
  const button = document.querySelector('kay-dev')?.shadowRoot?.querySelector<HTMLButtonElement>(`#kay-dev-tab-${id}`)

  button?.click()

  return button !== undefined && button !== null
}

describe.skipIf(path === undefined && (process.env.CI ?? '') === '')('the Mail tab under kay dev', () => {
  let app: Awaited<ReturnType<typeof devApp>>
  let page: TestPage
  const file = () => join(app.root, '.kay/mail-outbox.json')

  const mails = async (...subjects: string[]) => {
    await page.waitUntil(openTab, undefined, 'problems')
    await page.waitUntil(openTab, undefined, 'mail')
    await page.waitUntil((count: number) => document.querySelector('kay-dev')!.shadowRoot!.querySelectorAll('#kay-dev-mail .row').length === count, undefined, subjects.length)

    expect(await page.evaluate(listed)).toEqual(subjects)
  }

  beforeAll(async () => {
    app = await devApp()
    await fetch(`${app.url}/send/1`)
    await fetch(`${app.url}/send/2`)
    page = await browse(`${app.url}/`, { path, strict: false })
  }, 60_000)

  afterAll(async () => {
    page?.close()
    await app?.stop()
  })

  it('keeps its mails through another tab of the dev tool, a hidden and shown browser tab and a page swap', async () => {
    await mails('Mail 2', 'Mail 1')

    await page.evaluate(() => {
      for (const state of ['hidden', 'visible']) {
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state })
        document.dispatchEvent(new Event('visibilitychange'))
      }
    })
    await mails('Mail 2', 'Mail 1')

    await page.click('a.other')
    await page.waitFor('h1', { text: 'Other' })
    await mails('Mail 2', 'Mail 1')
  }, 60_000)

  it('keeps its mails in .kay when the server restarts for an edit, and lists them in a page loaded after', async () => {
    await app.restart()
    await page.reload()
    await mails('Mail 2', 'Mail 1')

    expect(await Bun.file(file()).json()).toHaveLength(2)
  }, 60_000)

  it('empties the tab and the file from its Clear button, and stays empty through a restart', async () => {
    await page.evaluate(() => [...document.querySelector('kay-dev')!.shadowRoot!.querySelectorAll<HTMLButtonElement>('#kay-dev-mail button.tool')].find(button => button.textContent === 'Clear')!.click())
    await page.waitUntil(() => document.querySelector('kay-dev')!.shadowRoot!.querySelectorAll('#kay-dev-mail .row').length === 0)

    expect(await page.evaluate(listed)).toEqual([])
    expect(await Bun.file(file()).json()).toEqual([])

    await app.restart()
    await fetch(`${app.url}/send/3`)
    await page.reload()
    await mails('Mail 3')
  }, 60_000)

  it('writes no file under bun test', () => {
    expect(existsSync(join(process.cwd(), '.kay/mail-outbox.json'))).toBe(false)
  })
})
