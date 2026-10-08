import type { DesktopMessage } from '../server/desktop'
import type { WindowSettings } from './library'
import process from 'node:process'
import { createWebview } from './webview'

export interface WindowOptions extends WindowSettings {
  // The module running the app's server, the worker entry `kay build --desktop` generates.
  worker: string
  // The webview library the executable embeds for its platform.
  library: string
}

// Run with it, the executable prints the URL a browser opens the app at rather than opening its window, to debug it in the browser's devtools.
const NO_WINDOW = '--no-window'

// Called from the page whenever its title changes, the name a script can't collide with since nothing else is bound.
const TITLE_BINDING = '__kayDesktopTitle'

// Keeps the window's title on the page's, through page swaps too, which replace the head's `<title>`.
const FOLLOW_TITLE = `addEventListener('DOMContentLoaded', () => {
  const send = () => document.title && ${TITLE_BINDING}(document.title)
  send()
  new MutationObserver(send).observe(document.head, { childList: true, subtree: true, characterData: true })
})`

// Runs the server in a worker, since the webview's loop blocks the thread it runs on, then opens the window on it; closing the window stops the server as a signal would.
export async function openWindow(options: WindowOptions): Promise<void> {
  const worker = new Worker(options.worker)
  const closed = new Promise(resolve => worker.addEventListener('close', resolve))
  const listening = await new Promise<string>((resolve, reject) => {
    worker.addEventListener('message', (event: MessageEvent<DesktopMessage>) => {
      if (event.data.kind === 'listening')
        resolve(event.data.url)
    })
    worker.addEventListener('error', event => reject(new Error(event.message)))
    worker.addEventListener('close', () => reject(new Error('kay: the server stopped before it listened')))
  })
  const stop = async () => {
    worker.postMessage('stop')
    await closed
    process.exit()
  }

  if (process.argv.includes(NO_WINDOW)) {
    console.log(`Open ${listening}`)
    process.once('SIGINT', () => void stop())
    process.once('SIGTERM', () => void stop())

    return
  }

  showWindow(options.library, listening, options)
  await stop()
}

// Opens a window on `url` and returns once it is closed; `devtools` lets the page be inspected, as `kay dev --desktop` does.
export function showWindow(library: string, url: string, settings: WindowSettings, devtools = false): void {
  const webview = createWebview(library, settings, devtools)

  webview.setTitle(settings.title)
  webview.bind(TITLE_BINDING, (title: string) => webview.setTitle(title))
  webview.init(FOLLOW_TITLE)
  webview.navigate(url)
  webview.run()
}
