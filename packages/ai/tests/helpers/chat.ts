import type { TestPage } from 'kay/test'

// Waits for the reply under way to end and for the Markdown renderer, loaded with the first reply to draw, to have formatted it: a turn that ends first shows its text as written until then, a citation in its code linked.
export async function replied(page: TestPage): Promise<void> {
  await page.waitFor('[data-pending]', { gone: true })
  await markdownDrawn(page)
}

// Waits for the Markdown renderer once a reply has text, which asks for it: importing its module again resolves once it and its imports have run, and a task later the chat has drawn what it formats.
export async function markdownDrawn(page: TestPage): Promise<void> {
  await page.waitUntil(() => document.querySelector('.kai-chat-turn[data-role="assistant"] .kai-chat-text') === null || performance.getEntriesByType('resource').some(entry => entry.name.includes('markdown-render')))
  await page.evaluate(async () => {
    const renderer = performance.getEntriesByType('resource').find(entry => entry.name.includes('markdown-render'))

    if (renderer)
      await import(renderer.name)

    await new Promise(resolve => setTimeout(resolve, 0))
  })
}
