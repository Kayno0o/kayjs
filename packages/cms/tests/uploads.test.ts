import { expect, test } from 'bun:test'
import { files, memoryFiles } from 'kay/server'
import { setupStorage } from '../../../src/server/storage'
import { configure } from '../src/settings'
import { emptyFile, sizeOfPath, tooLarge, typeName } from '../src/upload-text'
import { uploadMaxSize, uploadRefusal, uploadRules } from '../src/uploads'

const PNG = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1]
const JPEG = [0xFF, 0xD8, 0xFF, 0xE0, 0, 16, 0x4A, 0x46, 0x49, 0x46]
const GIF = [...Buffer.from('GIF89a'), 1, 0, 1, 0]
const WEBP = [...Buffer.from('RIFF'), 0, 0, 0, 0, ...Buffer.from('WEBPVP8 ')]
const AVIF = [0, 0, 0, 16, ...Buffer.from('ftypavif'), 0, 0, 0, 0]
const PDF = [...Buffer.from('%PDF-1.7\n')]
const HTML = '<!doctype html><script>fetch("/admin")</script>'
const SVG_WITH_SCRIPT = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'

function upload(name: string, content: string | number[], type = ''): File {
  return new File([typeof content === 'string' ? content : new Uint8Array(content)], name, { type })
}

test('takes images and PDFs by default, read off the name as storage serves them, whatever type they were sent as', async () => {
  configure({})

  expect(await uploadRefusal(upload('photo.JPG', JPEG, 'text/html'))).toBeUndefined()
  expect(await uploadRefusal(upload('brochure.pdf', PDF))).toBeUndefined()
  expect(await uploadRefusal(upload('app.js', 'x', 'image/png'))).toContain('app.js is text/javascript')
  expect(await uploadRefusal(upload('drawing.svg', SVG_WITH_SCRIPT))).toContain('image/svg+xml')
  expect(await uploadRefusal(upload('noextension', PNG, 'image/png'))).toBeUndefined()
})

test('takes each image format by its bytes, the name in any case', async () => {
  configure({})

  for (const [name, bytes] of [['a.png', PNG], ['a.PNG', PNG], ['a.jpg', JPEG], ['a.jpeg', JPEG], ['a.JPG', JPEG], ['a.gif', GIF], ['a.webp', WEBP], ['a.avif', AVIF], ['a.pdf', PDF], ['a.PDF', PDF]] as const)
    expect(await uploadRefusal(upload(name, bytes))).toBeUndefined()
})

test('takes an AVIF that lists its brand among the compatible ones, and refuses one that lists none', async () => {
  configure({})

  expect(await uploadRefusal(upload('a.avif', [0, 0, 0, 24, ...Buffer.from('ftypmif1'), 0, 0, 0, 0, ...Buffer.from('mif1avif')]))).toBeUndefined()
  expect(await uploadRefusal(upload('a.avif', [0, 0, 0, 16, ...Buffer.from('ftypmif1'), 0, 0, 0, 0]))).toContain('is not a real')
  expect(await uploadRefusal(upload('a.avif', [0, 0, 0, 4, ...Buffer.from('ftypavif')]))).toContain('is not a real')
})

test('refuses bytes that are not the type the name gives, whatever extension or declared type they come with', async () => {
  configure({})

  for (const file of [upload('x.png', HTML), upload('x.PNG', HTML, 'image/png'), upload('x.html.png', HTML), upload('x.png.png', HTML), upload('x.jpg', PNG), upload('x.png', JPEG), upload('x.gif', WEBP), upload('x.webp', GIF), upload('x.avif', PNG), upload('x.pdf', HTML), upload('x.pdf', PNG), upload('noextension', HTML, 'image/png'), upload('noextension', JPEG, 'image/png'), upload('x.png', ''), upload('x.png', PNG.slice(0, 5)), upload('x.png', PNG.slice(0, 14)), upload('x.png', JPEG.slice(0, 2))])
    expect(await uploadRefusal(file)).toContain('is not a real')
})

test('names a refused file and the type it claims', async () => {
  configure({})

  expect(await uploadRefusal(upload('x.png', HTML))).toBe('x.png is not a real image/png')
  expect(await uploadRefusal(upload('', HTML, 'image/png'))).toBe('The file is not a real image/png')
})

test('a double extension is judged by its last one', async () => {
  configure({})

  expect(await uploadRefusal(upload('x.png.html', HTML))).toContain('text/html, which uploads here do not take')
  expect(await uploadRefusal(upload('x.html.png', PNG))).toBeUndefined()
})

test('takes an SVG only when uploads lists it, and only one that is an SVG', async () => {
  configure({ uploads: ['image/svg+xml'] })

  expect(await uploadRefusal(upload('logo.svg', SVG_WITH_SCRIPT))).toBeUndefined()
  expect(await uploadRefusal(upload('logo.SVG', '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeUndefined()
  expect(await uploadRefusal(upload('logo.svg', HTML))).toContain('is not a real image/svg+xml')
  expect(await uploadRefusal(upload('logo.svg', PNG))).toContain('is not a real image/svg+xml')
  expect(await uploadRefusal(upload('logo.png', SVG_WITH_SCRIPT))).toContain('which uploads here do not take')
})

test('checks each image type a family takes, and leaves a type it cannot recognise to its name', async () => {
  configure({ uploads: ['image/*', 'text/csv', 'video/mp4'] })

  expect(await uploadRefusal(upload('x.png', HTML))).toContain('is not a real')
  expect(await uploadRefusal(upload('table.csv', 'a,b'))).toBeUndefined()
  expect(await uploadRefusal(upload('clip.mp4', 'whatever'))).toBeUndefined()
  expect(await uploadRefusal(upload('table.csv', 'a,b', 'image/png'))).toBeUndefined()
})

test('takes the types an app lists, exact or by family', async () => {
  configure({ uploads: ['image/*', 'text/csv'] })

  expect(await uploadRefusal(upload('drawing.svg', SVG_WITH_SCRIPT))).toBeUndefined()
  expect(await uploadRefusal(upload('table.csv', 'x'))).toBeUndefined()
  expect(await uploadRefusal(upload('table.csv', 'x', ''))).toBeUndefined()
  expect(await uploadRefusal(upload('brochure.pdf', PDF))).toContain('which uploads here do not take: image/*, text/csv')
})

test('offers the picker the types uploads takes, an image field the image ones among them, with the size limit', () => {
  configure({})

  expect(uploadRules()).toEqual({ accept: 'image/png,image/jpeg,image/webp,image/gif,image/avif,application/pdf', images: 'image/png,image/jpeg,image/webp,image/gif,image/avif', maxSize: 20 * 1024 * 1024 })

  configure({ uploads: ['image/*', 'text/csv'] })
  expect(uploadRules()).toMatchObject({ accept: 'image/*,text/csv', images: 'image/*' })

  configure({ uploads: ['application/pdf'] })
  expect(uploadRules()).toMatchObject({ accept: 'application/pdf', images: 'application/pdf' })
})

test('reads uploads as a list of types, or as types and maxSize, each part optional', () => {
  const defaults = 'image/png,image/jpeg,image/webp,image/gif,image/avif,application/pdf'

  configure({ uploads: ['application/pdf'] })
  expect(uploadRules()).toMatchObject({ accept: 'application/pdf', maxSize: 20 * 1024 * 1024 })

  configure({ uploads: { types: ['application/pdf'] } })
  expect(uploadRules()).toMatchObject({ accept: 'application/pdf', maxSize: 20 * 1024 * 1024 })

  configure({ uploads: { maxSize: '50mb' } })
  expect(uploadRules()).toMatchObject({ accept: defaults, maxSize: 50 * 1024 * 1024 })

  configure({ uploads: { types: ['video/*'], maxSize: 1500 } })
  expect(uploadRules()).toMatchObject({ accept: 'video/*', maxSize: 1500 })

  configure({ uploads: {} })
  expect(uploadRules()).toMatchObject({ accept: defaults, maxSize: 20 * 1024 * 1024 })

  configure({ uploads: { maxSize: '1.5mb' } })
  expect(uploadRules().maxSize).toBe(1.5 * 1024 * 1024)
})

test('the upload route reads the limit and its envelope, so a file at the limit gets in', () => {
  configure({ uploads: { maxSize: '50mb' } })
  expect(uploadMaxSize()).toBe(50 * 1024 * 1024 + 64 * 1024)
})

test('lists 50 entries a page unless pageSize says otherwise, and refuses one that is no positive whole number', () => {
  expect(configure({}).pageSize).toBe(50)
  expect(configure({ pageSize: 20 }).pageSize).toBe(20)

  for (const pageSize of [0, -1, 1.5, Number.NaN, Infinity, '20'])
    expect(() => configure({ pageSize } as never)).toThrow(expect.objectContaining({ code: 'config-invalid', message: expect.stringContaining('pageSize') }))

  // A browser-safe checker's plain error is raised as a config error too.
  expect(() => configure({ collections: { posts: { form: { toolbar: 'bold' } } } } as never)).toThrow(expect.objectContaining({ code: 'config-invalid' }))
  expect(() => configure({ roles: { editor: ['nope'] }, guard: () => undefined } as never)).toThrow(expect.objectContaining({ code: 'config-invalid' }))

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
  expect(uploadMaxSize()).toBe(128 * 1024 * 1024)

  for (const maxSize of [most + 1, '128mb', '200mb', 1e12])
    expect(() => configure({ uploads: { maxSize } as never })).toThrow(/maxSize.*at most/)
})

const typeJudged = async (name: string) => (/^\S+ is ([^,;]+)/).exec((await uploadRefusal(upload(name, 'x'))) ?? '')?.[1]
const typeServed = async (name: string) => (await files.response(await files.put(upload(name, 'x'), {}))).headers.get('content-type')?.replace(/;.*$/, '')

test('judges a name as the type kay\'s file route serves it, whatever its case or extension', async () => {
  configure({ uploads: [] })
  setupStorage(memoryFiles(), '/nonexistent', undefined)

  // A type a browser may show is served as itself, so the check cannot judge it as another.
  for (const name of ['a.png', 'a.PNG', 'a.JpG', 'a.jpeg', 'a.webp', 'a.gif', 'a.avif', 'a.AVIF', 'a.pdf', 'a.svg', 'a.SVG', 'a.txt', 'a.mp4'])
    expect(await typeServed(name), name).toBe(await typeJudged(name))

  // Any other is a download of no type, whatever it is judged as.
  for (const name of ['a.html', 'a.js', 'a.json', 'a.png.html'])
    expect(await typeServed(name), name).toBe('application/octet-stream')
})

test('reads the size off a stored key, with or without the placeholder colour kay keeps in it, and none off another file', () => {
  expect(sizeOfPath('/_kay/files/products/a1.1600x1200-c86432.jpg')).toEqual({ width: 1600, height: 1200 })
  expect(sizeOfPath('/_kay/files/products/a1.1600x1200.png?v=2')).toEqual({ width: 1600, height: 1200 })
  expect(sizeOfPath('/_kay/files/products/a1.pdf')).toBeUndefined()
})

test('a type reads as the extension an editor knows, a vendor\'s long ones included', () => {
  expect(['image/png', 'image/svg+xml', 'application/pdf', 'image/*'].map(typeName)).toEqual(['PNG', 'SVG', 'PDF', 'images'])
  expect(['application/vnd.ms-excel', 'application/msword', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'].map(typeName)).toEqual(['XLS', 'DOC', 'XLSX'])
  expect(typeName('application/vnd.acme.report')).toBe('ACME.REPORT')
  expect(typeName('application/x-tar')).toBe('TAR')
})
