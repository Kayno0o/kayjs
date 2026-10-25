import { mount, renderServer } from './runtime'

// The sandboxed frame the playground shows a component in. It has no network and no access to the docs: the parent posts the compiled code and gets the server's markup back, while the browser's version runs here in the page.
const root = document.getElementById('root')!
let unmount: (() => void) | undefined

// What the component shows after a click or a timer changed it, which the page cannot read from its sandbox: only the browser tests look at it.
new MutationObserver(() => parent.postMessage({ shown: root.textContent ?? '' }, '*')).observe(root, { childList: true, characterData: true, subtree: true })

addEventListener('message', (event: MessageEvent<{ ping?: boolean, id: number, server: string, dom: string }>) => {
  if (event.source !== parent)
    return

  // The page pings while it shows the frame: code that blocks this thread, now or later, leaves the ping unanswered.
  if (event.data?.ping) {
    parent.postMessage({ pong: true }, '*')

    return
  }

  if (typeof event.data?.server !== 'string' || typeof event.data.dom !== 'string')
    return

  const { id, server, dom } = event.data

  unmount?.()
  unmount = undefined

  const reply: { id: number, html?: string, live?: string, error?: string } = { id }

  try {
    reply.html = renderServer(server)
    unmount = mount(dom, root)
    reply.live = root.textContent ?? ''
  }
  catch (error) {
    reply.error = error instanceof Error ? error.message : String(error)
  }

  parent.postMessage(reply, '*')
})

parent.postMessage({ ready: true }, '*')
