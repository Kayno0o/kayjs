import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { browserPath, testSite } from 'kay/test'
import { ui } from '../src/extension'

const path = browserPath()

interface Seen {
  labelledby: string | null
  label: string | null
  described: (string | null | undefined)[]
  invalid: string | null
  required: string | null
  name: string | null | undefined
  firstInvalid: string | null
  firstDescribed: string | null
}

describe.skipIf(path === undefined && (process.env.CI ?? '') === '')('a choice group in a FormField is the field', () => {
  let site: Awaited<ReturnType<typeof testSite>>
  let seen: Record<string, Seen>

  beforeAll(async () => {
    site = await testSite({ root: `${import.meta.dir}/fixture`, extensions: [ui()], browser: { path } })

    await using page = await site.open('/choice-fields')
    const read = async () => page.evaluate(() => Object.fromEntries(['radio', 'segmented', 'chips', 'rating', 'grouped', 'quiet'].map((id) => {
      const root = document.getElementById(id)!
      const first = root.querySelector('input')!
      const labelledby = root.getAttribute('aria-labelledby')

      return [id, {
        labelledby,
        label: root.getAttribute('aria-label'),
        described: (root.getAttribute('aria-describedby') ?? '').split(' ').filter(Boolean).map(described => document.getElementById(described)?.textContent),
        invalid: root.getAttribute('aria-invalid'),
        required: root.getAttribute('aria-required'),
        name: labelledby === null ? undefined : document.getElementById(labelledby)?.textContent,
        firstInvalid: first.getAttribute('aria-invalid'),
        firstDescribed: first.getAttribute('aria-describedby'),
      }]
    })))

    // The groups link themselves as they are drawn in the browser.
    for (let tries = 0; tries < 200; tries++) {
      seen = await read()

      if (seen.radio?.labelledby !== null)
        break

      await Bun.sleep(25)
    }
  }, 120_000)

  afterAll(async () => site.close())

  for (const id of ['radio', 'segmented', 'chips', 'rating']) {
    it(`${id} carries the field's hint and message, and its first input none`, () => {
      expect(seen[id]!.invalid).toBe('true')
      expect(seen[id]!.described).toHaveLength(2)
      expect(seen[id]!.described[1]).toBe('Required')
      expect(seen[id]!.firstInvalid).toBeNull()
      expect(seen[id]!.firstDescribed).toBeNull()
    })
  }

  it('a radio group with no label of its own is named by the field label, and is required', () => {
    expect(seen.radio!.name).toStartWith('Size')
    expect(seen.radio!.label).toBeNull()
    expect(seen.radio!.required).toBe('true')
  })

  it('a group that names itself keeps its own name', () => {
    expect(seen.segmented!.label).toBe('View mode')
    expect(seen.segmented!.labelledby).toBeNull()
  })

  it('a field with no message names the group and leaves it unmarked', () => {
    expect(seen.quiet!.name).toBe('Quiet')
    expect(seen.quiet!.invalid).toBeNull()
  })

  it('a group marked for a message the server rendered is unmarked once a call clears it', async () => {
    await using page = await site.open('/choice-refused')
    const invalid = async () => page.evaluate(() => document.getElementById('size')!.getAttribute('aria-invalid'))

    // A native post the action refuses comes back with the message in the markup.
    await page.evaluate(() => {
      (window as unknown as { old: boolean }).old = true
      document.querySelector<HTMLFormElement>('#pick')!.submit()
    })
    await page.waitUntil(() => !(window as unknown as { old?: boolean }).old && document.querySelector('#pick') !== null)
    await page.waitUntil(() => document.getElementById('size')?.getAttribute('aria-invalid') === 'true')
    expect(await invalid()).toBe('true')
    await Bun.sleep(1500)
    await page.click('input[name=size][value=b]')
    await page.click('#pick-submit')
    // The call now refuses the note alone, so the group's message goes.
    await page.waitUntil(() => document.querySelector('#pick [data-field=note] [data-form-issue]') !== null && document.querySelector('#pick [data-field=size] [data-form-issue]') === null)
    expect(await invalid()).toBeNull()
  }, 120_000)

  it('a FormField with group leaves its fieldset to name and describe the fields', () => {
    expect(seen.grouped!.labelledby).toBeNull()
    expect(seen.grouped!.label).toBe('Grouped')
  })
})
