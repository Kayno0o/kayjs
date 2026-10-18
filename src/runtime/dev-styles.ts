// Loaded by every page the dev server serves, which links the whole stylesheet: a production page carries only the rules of the classes its files name, so an element getting a class the stylesheet styles but the page's set lacks would be unstyled there.
// Each page's set comes in a `data-kay-page-classes` block of its head; an element carrying a class it lacks logs a `[kay]` error once.
const DATA = 'script[data-kay-page-classes]'
const CLASS_NAME = /^(?:\\[\da-f]{1,6}[ \t\n\r\f]?|\\[^\da-f]|[\w\u0080-\uFFFF-])+/i
const ESCAPE = /\\(?:([\da-f]{1,6})[ \t\n\r\f]?|([^\da-f]))/gi
const LISTED = 'list it in your stylesheet with @source inline("...") or write it out as a literal in a component'

function unescape(name: string): string {
  return name.replace(ESCAPE, (_match, hex: string | undefined, char: string | undefined) => {
    if (hex === undefined)
      return char!

    const code = Number.parseInt(hex, 16)

    return code === 0 || code > 0x10FFFF || (code >= 0xD800 && code <= 0xDFFF) ? '\uFFFD' : String.fromCodePoint(code)
  })
}

// The classes a selector needs outside any parentheses or brackets, as the build prunes by (`selectors` in src/build/class-rules.ts, which this mirrors without its imports): `.a :is(.b)` needs `a` alone, and the `:where(.group)` of a `group-open:` variant needs none, so a class only such rules mention has no rule of its own to be missing.
function neededClasses(selector: string, into: Set<string>): void {
  let depth = 0

  for (let at = 0; at < selector.length; at++) {
    const char = selector[at]!

    if (char === '\\') {
      at++
    }
    else if (char === '(' || char === '[') {
      depth++
    }
    else if ((char === ')' || char === ']') && depth > 0) {
      depth--
    }
    else if (char === '.' && depth === 0) {
      const name = CLASS_NAME.exec(selector.slice(at + 1))?.[0] ?? ''

      if (name !== '')
        into.add(unescape(name))

      at += name.length
    }
  }
}

// Every class some rule of the document's stylesheets needs.
function styledClasses(doc: Document): Set<string> {
  const found = new Set<string>()
  const walk = (rules: CSSRuleList) => {
    for (const rule of rules) {
      if (rule instanceof CSSStyleRule) {
        neededClasses(rule.selectorText, found)
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
  let styled: { sheets: CSSStyleSheet[], set: Set<string> } | undefined
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
      const sheets = [...doc.styleSheets]

      if (styled === undefined || styled.sheets.length !== sheets.length || styled.sheets.some((sheet, at) => sheet !== sheets[at]))
        styled = { sheets, set: styledClasses(doc) }

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
