import { describe, expect, it } from 'bun:test'
import { fileAnswer } from '../src/server'

const file = () => new File(['0123456789'], 'clip.txt', { type: 'text/plain' })
const ask = (range?: string, method = 'GET') => new Request('http://localhost/', { method, headers: range === undefined ? {} : { range } })

describe('fileAnswer', () => {
  it('answers one range 206 with its content-range', async () => {
    const response = fileAnswer(file(), ask('bytes=2-5'))

    expect(response.status).toBe(206)
    expect(response.headers.get('content-range')).toBe('bytes 2-5/10')
    expect(response.headers.get('content-length')).toBe('4')
    expect(response.headers.get('accept-ranges')).toBe('bytes')
    expect(await response.text()).toBe('2345')
  })

  it('answers an open-ended, a suffix and an overlong range', async () => {
    expect(await fileAnswer(file(), ask('bytes=7-')).text()).toBe('789')
    expect(await fileAnswer(file(), ask('bytes=-3')).text()).toBe('789')
    expect(await fileAnswer(file(), ask('bytes=-100')).text()).toBe('0123456789')
    expect(await fileAnswer(file(), ask('bytes=8-100')).text()).toBe('89')
    expect(fileAnswer(file(), ask('bytes=-3')).headers.get('content-range')).toBe('bytes 7-9/10')
  })

  it('refuses a range past the end with 416 and the size', () => {
    for (const range of ['bytes=10-', 'bytes=12-20', 'bytes=-0']) {
      const response = fileAnswer(file(), ask(range))

      expect(response.status, range).toBe(416)
      expect(response.headers.get('content-range'), range).toBe('bytes */10')
    }
  })

  it('answers the whole file to a header it does not read', async () => {
    for (const range of ['bytes=0-1,4-5', 'bytes=-', 'bytes=5-2', 'items=0-1', 'bytes=a-b', 'garbage']) {
      const response = fileAnswer(file(), ask(range))

      expect(response.status, range).toBe(200)
      expect(response.headers.get('content-range'), range).toBeNull()
      expect(await response.text(), range).toBe('0123456789')
    }
  })

  it('answers HEAD with the headers and no body', async () => {
    const whole = fileAnswer(file(), ask(undefined, 'HEAD'))

    expect(whole.status).toBe(200)
    expect(whole.headers.get('content-length')).toBe('10')
    expect(await whole.text()).toBe('')

    const part = fileAnswer(file(), ask('bytes=2-5', 'HEAD'))

    expect(part.status).toBe(206)
    expect(part.headers.get('content-length')).toBe('4')
    expect(await part.text()).toBe('')
  })

  it('answers an empty file whole, and any range of it 416', async () => {
    const empty = () => new File([], 'empty.txt', { type: 'text/plain' })

    expect(fileAnswer(empty(), ask()).status).toBe(200)
    expect(await fileAnswer(empty(), ask()).text()).toBe('')

    for (const range of ['bytes=0-', 'bytes=0-0', 'bytes=-5']) {
      const response = fileAnswer(empty(), ask(range))

      expect(response.status, range).toBe(416)
      expect(response.headers.get('content-range'), range).toBe('bytes */0')
    }
  })

  it('serves a BunFile and takes a type, cache and headers', async () => {
    const response = fileAnswer(Bun.file(`${import.meta.dir}/file-answer.test.ts`), ask('bytes=0-5'), { type: 'text/x', cacheControl: 'no-store', headers: { 'x-own': '1' } })

    expect(response.status).toBe(206)
    expect(await response.text()).toBe('import')
    expect(response.headers.get('content-type')).toBe('text/x')
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('x-own')).toBe('1')
  })

  it('names a download, whatever the name holds', () => {
    const named = (attachment: string | boolean, blob: Blob = file()) => fileAnswer(blob, ask(), { attachment }).headers.get('content-disposition')

    expect(fileAnswer(file(), ask()).headers.get('content-disposition')).toBeNull()
    expect(named('report.pdf')).toBe('attachment; filename="report.pdf"')
    expect(named(true)).toBe('attachment; filename="clip.txt"')
    expect(named(true, new Blob(['x']))).toBe('attachment; filename="download"')
    expect(named('été.pdf')).toBe('attachment; filename="_t_.pdf"; filename*=UTF-8\'\'%C3%A9t%C3%A9.pdf')

    for (const name of ['we"ird.pdf', 'a;b%c.pdf', 'line\r\nbreak: x.pdf', 'it\'s (1).pdf']) {
      const disposition = named(name)!

      expect(disposition, name).toMatch(/^attachment; filename="[\x20-\x7E]*"; filename\*=UTF-8''[\w%.-]+$/)
      expect(decodeURIComponent((/filename\*=UTF-8''(.+)$/).exec(disposition)![1]!), name).toBe(name)
    }

    // A path in the name leaves only its last segment.
    expect(named('../../etc/passwd')).toBe('attachment; filename="passwd"')
  })
})
