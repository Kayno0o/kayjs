// The SSR compiler's emission of `<Suspense>` and `<Catch>`, whose children must reach the component unrendered.

import type { JSXChild, JSXElement, JSXFragment, Node } from 'oxc-parser'
import type { StringParts } from './ssr-helpers'
import { cleanJsxText, decodeHtmlEntities, filterMeaningfulChildren, isComponentTag, isJsxNode, jsxTagName } from './shared'
import { serializeComponentProps } from './ssr-helpers'

/** What the two emitters borrow from the running `compileSsr()`. */
export interface KayTagEmitter {
  use: (name: string) => string
  compileSubExpression: (node: Node) => string
  compileChildren: (children: readonly JSXChild[], slotMarkers?: boolean, inFragment?: boolean) => string
  compileJsx: (node: JSXElement | JSXFragment) => string
  markersAt: (offset: number) => boolean
  directAwaitNodes: WeakSet<Node>
}

// `<Suspense fallback={...}><AsyncComp .../></Suspense>` passes the raw component call or Promise.
export function emitSuspense(em: KayTagEmitter, node: JSXElement, tag: string, propEntries: string[], parts: StringParts): void {
  const meaningful = filterMeaningfulChildren(node.children)
  const only = meaningful.length === 1 ? meaningful[0]! : undefined
  if (only?.type === 'JSXElement' && isComponentTag(jsxTagName(only.openingElement.name))) {
    const inner = serializeComponentProps(only.openingElement.attributes, em.compileSubExpression)
    if (filterMeaningfulChildren(only.children).length > 0)
      inner.propEntries.push(`children: ${em.use('raw')}(${em.compileChildren(only.children)})`)
    const innerObj = inner.propEntries.length > 0 ? `{ ${inner.propEntries.join(', ')} }` : '{}'
    propEntries.push(`children: ${jsxTagName(only.openingElement.name)}(${innerObj})`)
  }
  else if (only?.type === 'JSXExpressionContainer' && only.expression.type !== 'JSXEmptyExpression') {
    propEntries.push(`children: ${em.compileSubExpression(only.expression)}`)
  }
  else if (only?.type === 'JSXText') {
    propEntries.push(`children: ${JSON.stringify(decodeHtmlEntities(cleanJsxText(only.value)))}`)
  }
  else if (only !== undefined && isJsxNode(only)) {
    propEntries.push(`children: ${em.use('raw')}(${em.compileJsx(only)})`)
  }
  const propsObj = propEntries.length > 0 ? `{ ${propEntries.join(', ')} }` : '{}'
  parts.pushExpr(`${em.use('ssrChild')}(${tag}(${propsObj}))`)
}

// `<Catch>` reads its children inside a try, so they reach it as a getter even when static; in an island it renders in a range of its own, which the browser swaps.
export function emitCatch(em: KayTagEmitter, node: JSXElement, tag: string, propEntries: string[], parts: StringParts): void {
  const meaningful = filterMeaningfulChildren(node.children)
  const awaits = node.children.some(c => em.directAwaitNodes.has(c))
  const markers = em.markersAt(node.start)
  if (meaningful.length > 0) {
    const childExpr = `${em.use('raw')}(${em.compileChildren(node.children, markers, markers && meaningful.length > 1)})`
    propEntries.push(`get children() { return ${awaits ? `(async () => ${childExpr})()` : childExpr} }`)
  }
  if (markers)
    parts.pushStatic('<!--k[-->')
  parts.pushExpr(`${em.use('ssrChild')}(${awaits ? 'await ' : ''}${tag}({ ${propEntries.join(', ')} }))`)
  if (markers)
    parts.pushStatic('<!--k]-->')
}
