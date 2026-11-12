import { join } from 'node:path'
import { afterAll, expect, it } from 'bun:test'
import { testSite } from 'kay/test'
import { confirmWords } from '../src/confirm'
import { ui } from '../src/extension'

const site = await testSite({ root: join(import.meta.dir, 'fixture'), extensions: [ui()], browser: true })

afterAll(async () => site.close())

// The page with its island hydrated: a click the island answers tells it did.
async function opened() {
  const page = await site.open('/confirm-ask')

  await page.click('#neutral')
  await page.waitUntil(() => document.querySelector('dialog[role=alertdialog][open]') !== null)
  await page.press('Escape')
  await page.waitUntil(() => document.querySelector('#answers')!.textContent === 'neutral:false')

  return page
}

const shown = () => document.querySelector('dialog[role=alertdialog][open]') !== null
const focused = () => document.activeElement?.textContent

it('words the danger preset as a delete and any other tone as a confirm', () => {
  expect(confirmWords('danger', {})).toMatchObject({ title: 'Confirm Deletion', confirm: 'Delete', look: 'danger' })
  expect(confirmWords('neutral', {})).toMatchObject({ title: 'Confirm', confirm: 'Confirm', look: 'accent' })
  expect(confirmWords('neutral', { label: 'Save', confirmLabel: 'Go' })).toMatchObject({ title: 'Save', confirm: 'Go' })
})

it('resolves false on Escape, with the focus on the safe button and back on the opener', async () => {
  await using page = await opened()

  await page.click('#danger')
  await page.waitUntil(shown)
  expect(await page.evaluate(focused)).toBe('Cancel')
  expect(await page.evaluate(() => document.querySelector('dialog[role=alertdialog] h2')!.textContent)).toBe('Confirm Deletion')
  await page.press('Escape')
  await page.waitUntil(() => document.querySelector('#answers')!.textContent === 'neutral:false,danger:false')
  expect(await page.evaluate(() => document.activeElement?.id)).toBe('danger')
}, 120_000)

it('resolves true on the confirm button, and false on the cancel button', async () => {
  await using page = await opened()

  await page.click('#neutral')
  await page.waitUntil(shown)
  await page.click('dialog[role=alertdialog] [data-part=footer] button:last-child')
  await page.waitUntil(() => document.querySelector('#answers')!.textContent === 'neutral:false,neutral:true')
  await page.click('#danger')
  await page.waitUntil(shown)
  await page.click('dialog[role=alertdialog] [data-part=footer] button:first-child')
  await page.waitUntil(() => document.querySelector('#answers')!.textContent === 'neutral:false,neutral:true,danger:false')
}, 120_000)

it('asks before a dialog drops typed text, which only a confirm drops', async () => {
  await using page = await opened()

  await page.click('#open')
  await page.waitUntil(() => document.querySelector('#form[open]') !== null)
  await page.type('hello')
  await page.press('Escape')
  await page.waitUntil(shown)
  expect(await page.evaluate(() => document.querySelector('dialog[role=alertdialog] h2')!.textContent)).toBe('Discard changes?')
  await page.press('Escape')
  // The focus goes back into the form before the next Escape, as it does for a reader.
  await page.waitUntil(() => document.querySelector('dialog[role=alertdialog][open]') === null && document.activeElement?.id === 'field')
  expect(await page.evaluate(() => document.querySelector('#form[open]') !== null)).toBe(true)
  await page.press('Escape')
  await page.waitUntil(shown)
  await page.click('dialog[role=alertdialog] [data-part=footer] button:last-child')
  await page.waitUntil(() => document.querySelector('#form[open]') === null)
}, 120_000)

it('asks before a side panel drops typed text, in the words the app gave', async () => {
  await using page = await opened()

  await page.click('#open-panel')
  await page.waitUntil(() => document.querySelector('#side[open]') !== null)
  await page.type('hello')
  await page.press('Escape')
  await page.waitUntil(shown)
  expect(await page.evaluate(() => document.querySelector('dialog[role=alertdialog] p')!.textContent)).toBe('Lose it?')
  await page.click('dialog[role=alertdialog] [data-part=footer] button:last-child')
  await page.waitUntil(() => document.querySelector('#side[open]') === null)
}, 120_000)

it('settles the open question and the queued ones with false when the only host goes', async () => {
  const bare = await testSite({ root: join(import.meta.dir, 'fixture'), browser: true })

  try {
    await using page = await bare.open('/confirm-unmount')

    await page.click('#ask')
    await page.waitUntil(() => document.querySelector('dialog[role=alertdialog][open]') !== null)
    // The modal covers the button, as it would a real one, so the app's code unmounts the host.
    await page.evaluate(() => document.querySelector<HTMLButtonElement>('#unmount')!.click())
    await page.waitUntil(() => document.querySelector('#answers')!.textContent === 'one:false,two:false')
  }
  finally {
    await bare.close()
  }
}, 120_000)
