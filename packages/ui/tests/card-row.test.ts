import { join } from 'node:path'
import { expect, test } from 'bun:test'

test('a CardRow\'s dimmed actions show in full where the device cannot hover', async () => {
  const source = await Bun.file(join(import.meta.dir, '..', 'src', 'card-row.kay')).text()

  expect(source).toContain('opacity-60')
  expect(source).toContain('[@media(hover:none)]:opacity-100')
})
