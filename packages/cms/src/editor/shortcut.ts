import { onCleanup, onMount } from 'kay'

interface KeyLike {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  shiftKey: boolean
  isComposing?: boolean
}

// Ctrl+S or Cmd+S alone, not while an input method is composing.
export function isSaveShortcut(event: KeyLike): boolean {
  return event.key.toLowerCase() === 's' && (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.isComposing !== true
}

// Saves on Ctrl+S or Cmd+S anywhere on the page, instead of the browser offering to save the page. Called in a component's script; the target is the document unless a test gives one.
export function saveShortcut(save: () => void | Promise<void>, target?: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>): void {
  if (typeof document === 'undefined' && !target)
    return

  onMount(() => {
    const listened = target ?? document
    const listener = (event: Event): void => {
      if (!isSaveShortcut(event as KeyboardEvent))
        return

      event.preventDefault()
      void keepFocus(save)
    }

    listened.addEventListener('keydown', listener)
    onCleanup(() => listened.removeEventListener('keydown', listener))
  })
}

// Runs the save and gives the focus back to the field the editor was typing in, which a form locked while saving drops.
async function keepFocus(save: () => void | Promise<void>): Promise<void> {
  const active = typeof document === 'undefined' ? null : document.activeElement

  await save()

  if (active && 'focus' in active && active.isConnected && document.activeElement !== active)
    (active as HTMLElement).focus()
}
