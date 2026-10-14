import { createSignal } from './reactive'

let shown: (() => boolean) | undefined

// Whether the tab shows, as one signal shared by whatever pauses while it is hidden; the listener is added on first use.
export function tabVisible(): boolean {
  if (!shown) {
    const [read, write] = createSignal(!document.hidden)

    document.addEventListener('visibilitychange', () => write(!document.hidden))
    shown = read
  }

  return shown()
}
