// Loaded by every page the dev server serves, which links the whole stylesheet: a production page carries only the rules of the classes its files name, so an element getting a class the stylesheet styles but the page's set lacks would be unstyled there.
// Each page's set comes in a `data-kay-page-classes` block of its head; an element carrying a class it lacks logs a `[kay]` error once.
const DATA = 'script[data-kay-page-classes]'
const SELECTOR_CLASS = /\.((?:\\.|[\w-])+)/g
const ESCAPE = /\\(.)/g
const LISTED = 'list it in your stylesheet with @source inline("...") or write it out as a literal in a component'

// Every class some rule of the document's stylesheets styles.
function styledClasses(doc: Document): Set<string> {
  const found = new Set<string>()
  const walk = (rules: CSSRuleList) => {
    for (const rule of rules) {
      if (rule instanceof CSSStyleRule) {
        for (const [, name] of rule.selectorText.matchAll(SELECTOR_CLASS))
          found.add(name!.replace(ESCAPE, '$1'))
      }

      if ('cssRules' in rule)
        walk((rule as CSSGroupingRule).cssRules)
    }
  }

  for (const sheet of doc.styleSheets) {
    try {
      walk(sheet.cssRules)
    }
    catch {
      // A stylesheet of another origin cannot be read.
    }
  }

  return found
}

function pageClasses(doc: Document): Set<string> | undefined {
  const text = doc.querySelector(DATA)?.textContent

  if (text === null || text === undefined)
    return undefined

  try {
    return new Set(JSON.parse(text) as string[])
  }
  catch {
    return undefined
  }
}

export function startStyleCheck(doc: Document = document): () => void {
  const warned = new Set<string>()
  let styled: { sheets: number, set: Set<string> } | undefined
  let known: { block: Element, set: Set<string> } | undefined
  const check = (element: Element) => {
    if (element.classList.length === 0)
      return

    const block = doc.querySelector(DATA)

    if (block === null)
      return

    if (known?.block !== block) {
      const set = pageClasses(doc)

      if (set === undefined)
        return

      known = { block, set }
    }

    for (const name of element.classList) {
      if (known.set.has(name) || warned.has(name))
        continue

      // A stylesheet still loading has no rules yet, so what they style is read again when one arrived.
      if (styled?.sheets !== doc.styleSheets.length)
        styled = { sheets: doc.styleSheets.length, set: styledClasses(doc) }

      if (!styled.set.has(name))
        continue

      warned.add(name)
      console.error(`[kay] the class "${name}" is set on <${element.localName}> and the whole stylesheet styles it, but this page carries no rule for it: ${LISTED}`)
    }
  }
  const visit = (node: Node) => {
    if (!(node instanceof Element))
      return

    check(node)

    for (const inner of node.querySelectorAll('[class]'))
      check(inner)
  }
  const watcher = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === 'attributes') {
        check(record.target as Element)

        continue
      }

      for (const node of record.addedNodes) {
        visit(node)
      }
    }
  })

  watcher.observe(doc.documentElement, { attributeFilter: ['class'], attributes: true, childList: true, subtree: true })
  visit(doc.documentElement)

  return () => watcher.disconnect()
}
