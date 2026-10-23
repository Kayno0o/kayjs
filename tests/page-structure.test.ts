import { describe, expect, it } from 'bun:test'
import { pageStructureLints } from '../src/check/page-structure'

const page = (path: string, html: string) => ({ path, file: `src/routes${path}/page.kay`, html })

describe('pageStructureLints', () => {
  const pages = [
    page('/', '<html><body><main><h1>Home</h1></main></body></html>'),
    page('/no-main', '<html><body><h1>Home</h1></body></html>'),
    page('/no-heading', '<html><body><main><h2>Home</h2></main></body></html>'),
    page('/neither', '<html><body><div>Home</div></body></html>'),
    page('/role', '<html><body><div role="main"><h1 class="x">Home</h1></div></body></html>'),
    page('/fragment', '<p>no body</p>'),
  ]

  it('names a page with no main, no h1 or neither, leaving a role="main" and a fragment alone', () => {
    expect(pageStructureLints({}, pages).map(problem => [problem.message, problem.severity])).toEqual([
      ['`/no-main` has no `main`', 'warning'],
      ['`/no-heading` has no `h1`', 'warning'],
      ['`/neither` has no `main` and no `h1`', 'warning'],
    ])
  })

  it('follows the level the config gives it', () => {
    expect(pageStructureLints({ lints: { 'unstructured-page': 'allow' } }, pages)).toEqual([])
    expect(pageStructureLints({ lints: { a11y: 'deny' } }, pages.slice(1, 2)).map(problem => problem.severity)).toEqual(['error'])
  })
})
