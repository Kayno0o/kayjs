import { expect, test } from 'bun:test'
import { configure } from '../src/settings'
import { uploadRefusal } from '../src/uploads'

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
  expect(uploadRefusal(new File(['x'], 'brochure.pdf'))).toContain('which uploads here do not take: image/*, text/csv')
})
