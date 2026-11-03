import { expect, test } from 'bun:test'
import { dropNestedMain } from '../src/pages/main'

const run = async (html: string) => dropNestedMain({ html } as Parameters<typeof dropNestedMain>[0])

test('a page with no other main keeps the prebuilt one, without its marker', async () => {
  expect(await run('<body><main class="kayjs-auth" data-kayjs-main=""><h1>Hi</h1></main></body>')).toBe('<body><main class="kayjs-auth"><h1>Hi</h1></main></body>')
})

test('beneath a layout main or role, the prebuilt one becomes a div', async () => {
  expect(await run('<body><main id="app"><main class="kayjs-auth" data-kayjs-main=""><h1>Hi</h1></main></main></body>')).toBe('<body><main id="app"><div class="kayjs-auth"><h1>Hi</h1></div></main></body>')
  expect(await run('<body><div role="main"><main class="kayjs-auth" data-kayjs-main><h1>Hi</h1></main></div></body>')).toBe('<body><div role="main"><div class="kayjs-auth"><h1>Hi</h1></div></div></body>')
})

test('a page without the marker is left alone', async () => {
  const html = '<body><main><h1>Hi</h1></main></body>'

  expect(await run(html)).toBe(html)
})
