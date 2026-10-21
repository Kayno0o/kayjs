import type { Mounted } from 'kay/test'
import type { ScreenCollection } from '../src/kay/contract'
import { afterEach, expect, test } from 'bun:test'
import { mountComponent } from 'kay/test'

const schema = { type: 'object', properties: { photo: { 'type': 'string', 'x-kay': { kind: 'image', alt: 'caption' } }, caption: { type: 'string' }, title: { type: 'string' } } }
const collection = { name: 'posts', title: 'Posts', kind: 'folder', localized: false, components: [], schema } as unknown as ScreenCollection
let mounted: Mounted | undefined

afterEach(() => {
  mounted?.unmount()
})

async function render(name: string): Promise<void> {
  mounted = await mountComponent('src/components/entry-field-probe.kay', { name, collection })
}

test('a field paired with an image is not rendered by itself, and the error names the image to render', async () => {
  await expect(render('caption')).rejects.toThrow('"caption" is the alt of its image "photo", which shows it: render "photo"')
})

test('a name the schema lacks throws, naming the schema\'s fields', async () => {
  await expect(render('nope')).rejects.toThrow('has no field "nope" to render; its fields are photo, title')
})

test('an image and an unpaired field render', async () => {
  await render('photo')
  expect(mounted?.root.querySelector('[data-kcms-path="photo"]')).not.toBeNull()
})
