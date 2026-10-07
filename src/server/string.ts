import type { JSX } from '../runtime/jsx'
import { collectDeferred } from '../runtime/await.server'
import { child, component } from '../runtime/html'
import { collectIslands } from '../runtime/island.server'

type PropsArgument<P> = object extends P ? [props?: P] : [props: P]

// Renders a component to its markup outside a page, as a mail or a feed needs: `await` blocks are waited for and rendered in place, and islands render their server markup with no script to run them.
export async function renderToString<P extends object>(view: (props: P) => JSX.Element, ...[props]: PropsArgument<P>): Promise<string> {
  return settled(() => component(view, props ?? {} as P))
}

async function settled(view: () => unknown): Promise<string> {
  const { result: { result: html }, deferred } = collectDeferred(() => collectIslands(() => child(view())))

  const blocks = await Promise.all(deferred.map(async (block) => {
    let value: unknown

    try {
      value = await block.value
    }
    catch (error) {
      // With no `catch` block the mail would go out with the content missing, so the render fails instead.
      if (!block.failed)
        throw error

      const failed = block.failed

      return { id: block.id, html: await settled(() => failed(error)) }
    }

    return { id: block.id, html: await settled(() => block.ready(value as never)) }
  }))

  let result = html

  for (const block of blocks) {
    const open = `<!--kay-await:${block.id}-->`
    const close = `<!--/kay-await:${block.id}-->`
    const start = result.indexOf(open)
    const end = result.indexOf(close, start)

    // A block rendered where nothing shows, as a `head` block outside a page, left no markers to replace.
    if (start === -1 || end === -1)
      continue

    result = result.slice(0, start) + block.html + result.slice(end + close.length)
  }

  return result
}
