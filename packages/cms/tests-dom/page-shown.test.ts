import { afterEach, expect, mock, spyOn, test } from 'bun:test'
import { isShown } from '../src/editor/session'

const happyDOM = (window as unknown as { happyDOM: { setURL: (url: string) => void } }).happyDOM

afterEach(() => {
  mock.restore()
  happyDOM.setURL('http://localhost/')
})

test('the page shown is told from its address under the site\'s base, a trailing slash and escaped characters aside', () => {
  const read = document.querySelector.bind(document)

  // The base is read from the page's meta tag, which is stubbed rather than added: the runtime keeps the first base it reads.
  spyOn(document, 'querySelector').mockImplementation((selector: string) => selector === 'meta[name="kay-base"]' ? { content: '/docs' } : read(selector))
  happyDOM.setURL('http://localhost/docs/posts/h%C3%A9llo/')
  expect(isShown('/posts/héllo')).toBe(true)
  expect(isShown('/docs/posts/héllo')).toBe(false)
  happyDOM.setURL('http://localhost/docs?x=1')
  expect(isShown('/')).toBe(true)
  happyDOM.setURL('http://localhost/documents/posts/hello')
  expect(isShown('/posts/hello')).toBe(false)
})
