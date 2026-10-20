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
export function saveShortcut(save: () => void, target?: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>): void {
  if (typeof document === 'undefined' && !target)
    return

  onMount(() => {
    const listened = target ?? document
    const listener = (event: Event): void => {
      if (!isSaveShortcut(event as KeyboardEvent))
        return

      event.preventDefault()
      save()
    }

    listened.addEventListener('keydown', listener)
    onCleanup(() => listened.removeEventListener('keydown', listener))
  })
}
