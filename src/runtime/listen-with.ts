import { activeOwner, runWithOwner } from './reactive'

// `onClick|capture` and `|passive`: listener options only reach `addEventListener`, which the document's one listener cannot take for each element, so the handler stays out of what that one runs.
export function listenWith(element: Element, name: string, handler: (event: Event) => void, options: AddEventListenerOptions): void {
  const owner = activeOwner

  element.addEventListener(name.slice(2).toLowerCase(), event => runWithOwner(owner, () => handler(event)), options)
}
