import type { Mounted } from 'kay/test'
import type { FormLayout, ScreenCollection } from '../src/kay/contract'
import { afterEach, expect, test } from 'bun:test'
import { mountComponent, settle } from 'kay/test'

const schema = { type: 'object', properties: { intro: { 'type': 'string', 'x-kay': { kind: 'markdown' } } } }
let mounted: Mounted | undefined

afterEach(() => {
  mounted?.unmount()
  mounted = undefined
})

function collectionWith(form?: FormLayout): ScreenCollection {
  return { name: 'posts', title: 'Posts', kind: 'folder', localized: false, components: [], schema, body: {}, layout: form === undefined ? undefined : { form } } as unknown as ScreenCollection
}

const buttons = (root: Element) => [...root.querySelectorAll('.kui-markdown-bar button')].map(button => button.getAttribute('aria-label'))

async function body(form?: Parameters<typeof collectionWith>[0]): Promise<HTMLElement> {
  mounted = await mountComponent('src/components/entry-body-probe.kay', { collection: collectionWith(form) })
  await settle()

  return mounted.root
}

test('the body is labelled Body with every button, until the collection words it and cuts the toolbar down', async () => {
  const plain = await body()

  expect(plain.querySelector('.kui-label-text')?.textContent).toBe('Body')
  expect(plain.querySelector('.kui-form-field-hint')).toBeNull()
  expect(buttons(plain)).toEqual(['Bold', 'Italic', 'Heading', 'Bulleted list', 'Numbered list', 'Link', 'Image'])
  mounted?.unmount()

  const worded = await body({ body: { label: 'Article', hint: 'Plain text, no HTML' }, toolbar: ['bold', 'link'] })

  expect(worded.querySelector('.kui-label-text')?.textContent).toBe('Article')
  expect(worded.querySelector('.kui-form-field-hint')?.textContent).toBe('Plain text, no HTML')
  expect(buttons(worded)).toEqual(['Bold', 'Link'])
  mounted?.unmount()

  expect(buttons(await body({ toolbar: false }))).toEqual([])
})

test('the collection\'s toolbar reaches a Markdown field as it reaches the body', async () => {
  mounted = await mountComponent('src/components/entry-field-probe.kay', { name: 'intro', collection: collectionWith({ toolbar: ['italic'] }) })
  await settle()

  expect(buttons(mounted.root)).toEqual(['Italic'])
})
