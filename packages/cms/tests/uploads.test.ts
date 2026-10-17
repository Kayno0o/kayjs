import { expect, test } from 'bun:test'
import { configure } from '../src/settings'
import { emptyFile, tooLarge } from '../src/upload-text'
import { uploadBodyLimit, uploadRefusal, uploadRules } from '../src/uploads'

test('takes images and PDFs by default, read off the name as storage serves them, whatever type they were sent as', () => {
  configure({})

  expect(uploadRefusal(new File(['x'], 'photo.JPG', { type: 'text/html' }))).toBeUndefined()
  expect(uploadRefusal(new File(['x'], 'brochure.pdf'))).toBeUndefined()
  expect(uploadRefusal(new File(['x'], 'app.js', { type: 'image/png' }))).toContain('app.js is text/javascript')
  expect(uploadRefusal(new File(['x'], 'drawing.svg'))).toContain('image/svg+xml')
  expect(uploadRefusal(new File(['x'], 'noextension', { type: 'image/png' }))).toBeUndefined()
})

test('takes the types an app lists, exact or by family', () => {
  configure({ uploads: ['image/*', 'text/csv'] })

  expect(uploadRefusal(new File(['x'], 'drawing.svg'))).toBeUndefined()
  expect(uploadRefusal(new File(['x'], 'table.csv'))).toBeUndefined()
  expect(uploadRefusal(new File(['x'], 'table.csv', { type: '' }))).toBeUndefined()
  expect(uploadRefusal(new File(['x'], 'brochure.pdf'))).toContain('which uploads here do not take: image/*, text/csv')
})

test('offers the picker the types uploads takes, an image field the image ones among them, with the size limit', () => {
  configure({})

  expect(uploadRules()).toEqual({ accept: 'image/png,image/jpeg,image/webp,image/gif,image/avif,application/pdf', images: 'image/png,image/jpeg,image/webp,image/gif,image/avif', maxBytes: 20 * 1024 * 1024 })

  configure({ uploads: ['image/*', 'text/csv'] })
  expect(uploadRules()).toMatchObject({ accept: 'image/*,text/csv', images: 'image/*' })

  configure({ uploads: ['application/pdf'] })
  expect(uploadRules()).toMatchObject({ accept: 'application/pdf', images: 'application/pdf' })
})

test('reads uploads as a list of types, or as types and maxSize, each part optional', () => {
  const defaults = 'image/png,image/jpeg,image/webp,image/gif,image/avif,application/pdf'

  configure({ uploads: ['application/pdf'] })
  expect(uploadRules()).toMatchObject({ accept: 'application/pdf', maxBytes: 20 * 1024 * 1024 })

  configure({ uploads: { types: ['application/pdf'] } })
  expect(uploadRules()).toMatchObject({ accept: 'application/pdf', maxBytes: 20 * 1024 * 1024 })

  configure({ uploads: { maxSize: '50mb' } })
  expect(uploadRules()).toMatchObject({ accept: defaults, maxBytes: 50 * 1024 * 1024 })

  configure({ uploads: { types: ['video/*'], maxSize: 1500 } })
  expect(uploadRules()).toMatchObject({ accept: 'video/*', maxBytes: 1500 })

  configure({ uploads: {} })
  expect(uploadRules()).toMatchObject({ accept: defaults, maxBytes: 20 * 1024 * 1024 })

  configure({ uploads: { maxSize: '1.5mb' } })
  expect(uploadRules().maxBytes).toBe(1.5 * 1024 * 1024)
})

test('the upload route reads the limit and its envelope, so a file at the limit gets in', () => {
  configure({ uploads: { maxSize: '50mb' } })
  expect(uploadBodyLimit()).toBe(50 * 1024 * 1024 + 64 * 1024)
})

test('lists 50 entries a page unless pageSize says otherwise, and refuses one that is no positive whole number', () => {
  expect(configure({}).pageSize).toBe(50)
  expect(configure({ pageSize: 20 }).pageSize).toBe(20)

  for (const pageSize of [0, -1, 1.5, Number.NaN, Infinity, '20'])
    expect(() => configure({ pageSize } as never)).toThrow(/pageSize/)

  configure({})
})

test('refuses a maxSize that is no positive whole number of bytes as kay.config.ts loads', () => {
  for (const maxSize of [0, -1, Number.NaN, Infinity, 1.5, '0mb', '-1mb', '1.5', 'big', '0.5b', ''])
    expect(() => configure({ uploads: { maxSize } as never })).toThrow(/maxSize/)
})

test('words a refusal for size and emptiness once, for the editor and the server', () => {
  expect(tooLarge('movie.mp4', 70 * 1024 * 1024, 50 * 1024 * 1024)).toBe('movie.mp4 is 70 MB, over the 50 MB an upload may be')
  expect(tooLarge('', 2048, 1024)).toBe('The file is 2 KB, over the 1 KB an upload may be')
  expect(tooLarge('a.pdf', 600, 500)).toBe('a.pdf is 600 bytes, over the 500 bytes an upload may be')
  expect(emptyFile('')).toBe('The file is empty')
})

test('refuses a maxSize the server would not take, Bun refusing a request body over 128 MB before the route sees it', () => {
  const most = 128 * 1024 * 1024 - 64 * 1024

  configure({ uploads: { maxSize: most } })
  expect(uploadBodyLimit()).toBe(128 * 1024 * 1024)

  for (const maxSize of [most + 1, '128mb', '200mb', 1e12])
    expect(() => configure({ uploads: { maxSize } as never })).toThrow(/maxSize.*at most/)
})
