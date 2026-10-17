import { expect, test } from 'bun:test'
import { configure } from '../src/settings'
import { uploadRefusal, uploadRules } from '../src/uploads'

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
