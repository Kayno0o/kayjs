import type { LateParts } from './navigation'
import { leave, navigation } from './navigation'

// What the page swap hands over, as importing it here would split the chunks the swap shares into one of their own (tests/build.test.ts).
export interface Swapper {
  inFlight: { late?: LateParts | undefined }
  entry: string
  runnable: (script: HTMLScriptElement, markup: string) => HTMLScriptElement
  scriptMarkup: (script: HTMLScriptElement) => string
  // Called after each part is placed.
  placed?: (() => void) | undefined
}

const SWAP_PATTERN = /\$kayAwait/

// What the server streamed after the first part arrives in templates the page's inline script would swap in; here they are put in place before the page is shown.
export function applyStreamed(page: Document): void {
  for (const template of page.querySelectorAll<HTMLTemplateElement>('template[data-kay-await]')) {
    const id = template.dataset.kayAwait
    const walker = page.createTreeWalker(page.body, NodeFilter.SHOW_COMMENT)
    let start: Node | null = null

    while (walker.nextNode()) {
      if ((walker.currentNode as Comment).data === `kay-await:${id}`) {
        start = walker.currentNode

        break
      }
    }

    if (start) {
      let node = start.nextSibling

      while (node && !(node.nodeType === Node.COMMENT_NODE && (node as Comment).data === `/kay-await:${id}`)) {
        const after = node.nextSibling

        node.remove()
        node = after
      }

      node?.remove()
      ;(start as ChildNode).replaceWith(template.content)
    }

    template.remove()
  }

  for (const script of page.querySelectorAll('body script')) {
    if (SWAP_PATTERN.test(script.textContent ?? ''))
      script.remove()
  }
}

// Puts the parts a streamed page goes on sending in place of the pending blocks of the page shown, one by one as they arrive, until the stream ends, a navigation stops it or it stalls.
// A stalled or broken stream leaves the pending branches as they are: asking the server again would repeat the slow request.
export async function followLate(late: LateParts, swapper: Swapper): Promise<void> {
  const { inFlight } = swapper

  late.followed = true
  inFlight.late = late

  try {
    for (let part = await late.read(); part !== undefined && !late.stopped; part = await late.read()) {
      // A part needing another build's runtime than the page runs is for a full load, as its page would have had.
      if (!placeLate(part, swapper)) {
        late.stop()
        leave(new URL(location.href), true)

        return
      }

      swapper.placed?.()
    }
  }
  catch (error) {
    if (!late.stopped)
      console.warn(error instanceof Error ? error.message : error)
  }
  finally {
    late.stop()

    if (inFlight.late === late)
      inFlight.late = undefined
  }
}

// Whether the part could be placed here; a part answering a block the page does not hold is dropped.
function placeLate(part: string, { entry, runnable, scriptMarkup }: Swapper): boolean {
  const parsed = new DOMParser().parseFromString(`<body>${part}`, 'text/html')
  const template = parsed.querySelector<HTMLTemplateElement>('template[data-kay-await]')
  const id = template?.dataset.kayAwait
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_COMMENT)
  let start: Node | null = null

  while (!start && walker.nextNode()) {
    if ((walker.currentNode as Comment).data === `kay-await:${id}`)
      start = walker.currentNode
  }

  const old: ChildNode[] = []
  let end = start?.nextSibling ?? null

  while (end && !(end.nodeType === Node.COMMENT_NODE && (end as Comment).data === `/kay-await:${id}`)) {
    old.push(end)
    end = end.nextSibling
  }

  if (!template || !start || !end)
    return true

  const ran = new Set([...document.scripts].map(scriptMarkup))
  const scripts: HTMLScriptElement[] = []

  for (const script of parsed.querySelectorAll('script')) {
    const markup = script.outerHTML

    if (SWAP_PATTERN.test(script.textContent ?? '') || ran.has(markup))
      continue

    if (script.matches(entry)) {
      const running = document.querySelector(entry)?.getAttribute('src')

      // The entry the page runs is not loaded twice; another one is for a full load.
      if (running === script.getAttribute('src'))
        continue

      if (running !== undefined)
        return false
    }

    scripts.push(runnable(script, markup))
  }

  for (const script of scripts)
    document.body.append(script)

  for (const node of old) {
    try {
      if (node instanceof Element)
        navigation.hooks!.dispose(node)
    }
    catch (error) {
      // A cleanup that throws must not leave the part half placed.
      reportError(error)
    }

    node.remove()
  }

  end.remove()
  ;(start as ChildNode).replaceWith(template.content)
  navigation.hooks!.hydrate(document.body)

  return true
}
