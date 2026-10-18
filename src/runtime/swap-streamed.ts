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
