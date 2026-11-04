import { join } from 'node:path'
import { afterAll, expect, it } from 'bun:test'
import { testSite } from 'kay/test'

const site = await testSite({ root: join(import.meta.dir, 'fixture'), browser: true })

afterAll(async () => site.close())

// The page the browser got back from a native post the action refused, which the islands then hydrate.
async function refused() {
  const page = await site.open('/refill')

  await page.evaluate(() => {
    const form = document.querySelector<HTMLFormElement>('#refill')!
    const set = (selector: string, run: (element: HTMLInputElement) => void) => run(form.querySelector<HTMLInputElement>(selector)!)

    set('input[name=name]', (element) => {
      element.value = 'A'
    })
    form.querySelector<HTMLTextAreaElement>('textarea[name=bio]')!.value = 'Hello'
    form.querySelector<HTMLSelectElement>('select[name=plan]')!.value = 'pro'
    set('input[name=size][value=l]', (element) => {
      element.checked = true
    })
    set('input[name=tags][value=a]', (element) => {
      element.checked = true
    })
    set('input[name=tags][value=c]', (element) => {
      element.checked = true
    })
    set('input[name=terms]', (element) => {
      element.checked = true
    })
    set('input[name=view][value=l]', (element) => {
      element.checked = true
    })
    set('input[name=stars][value="4"]', (element) => {
      element.checked = true
    })
    set('input[name=volume]', (element) => {
      element.value = '70'
    })
    set('input[name=colour]', (element) => {
      element.value = '#ff0000'
    })
    set('input[name=day]', (element) => {
      element.value = '2026-05-04'
    })
    set('input[name=hour]', (element) => {
      element.value = '07:30'
    })
    set('input[name=extras][value=b]', (element) => {
      element.checked = true
    });
    (window as unknown as { old: boolean }).old = true
    form.submit()
  })
  await page.waitUntil(() => !(window as unknown as { old?: boolean }).old && document.querySelector('#refill') !== null)

  return page
}

async function state(page: Awaited<ReturnType<typeof refused>>) {
  return page.evaluate(() => {
    const form = document.querySelector<HTMLFormElement>('#refill')!
    const checked = (selector: string) => [...form.querySelectorAll<HTMLInputElement>(selector)].filter(input => input.checked).map(input => input.value)

    return {
      name: form.querySelector<HTMLInputElement>('input[name=name]')!.value,
      bio: form.querySelector<HTMLTextAreaElement>('textarea[name=bio]')!.value,
      plan: form.querySelector<HTMLSelectElement>('select[name=plan]')!.value,
      size: checked('input[name=size]'),
      tags: checked('input[name=tags]'),
      terms: checked('input[name=terms]'),
      news: checked('input[name=news]'),
      view: checked('input[name=view]'),
      stars: checked('input[name=stars]'),
      volume: form.querySelector<HTMLInputElement>('input[name=volume]')!.value,
      colour: form.querySelector<HTMLInputElement>('input[name=colour]')!.value,
      day: form.querySelector<HTMLInputElement>('input[name=day]')!.value,
      hour: form.querySelector<HTMLInputElement>('input[name=hour]')!.value,
      extras: checked('input[name=extras]'),
    }
  })
}

it('keeps what a refused native post sent once the islands hydrate over the server markup', async () => {
  await using page = await refused()

  // A click an island answers tells it hydrated.
  await page.click('input[name=tags][value=b]')
  await page.waitUntil(() => document.querySelector<HTMLInputElement>('input[name=tags][value=b]')!.checked)

  expect(await state(page)).toEqual({ name: 'A', bio: 'Hello', plan: 'pro', size: ['l'], tags: ['a', 'b', 'c'], terms: ['on'], news: [], view: ['l'], stars: ['4'], volume: '70', colour: '#ff0000', day: '2026-05-04', hour: '07:30', extras: ['a', 'b'] })
  expect(page.errors).toEqual([])
}, 120_000)

it('lets a hydrated group be changed from the refilled choices, the others it did not touch staying as they were', async () => {
  await using page = await refused()

  await page.click('input[name=tags][value=a]')
  await page.waitUntil(() => !document.querySelector<HTMLInputElement>('input[name=tags][value=a]')!.checked)
  await page.click('input[name=terms]')
  await page.waitUntil(() => !document.querySelector<HTMLInputElement>('input[name=terms]')!.checked)

  const now = await state(page)

  expect(now.tags).toEqual(['c'])
  expect(now.terms).toEqual([])
  expect(now.size).toEqual(['l'])
}, 120_000)
