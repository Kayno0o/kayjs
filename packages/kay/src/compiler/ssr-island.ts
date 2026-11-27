// The SSR compiler's emission of an island: its server render inside the `<kay-island>` that hands its props and hydration mode to the browser.

import type { IslandBinding } from './ssr'
import type { StringParts } from './ssr-helpers'
import { escapeStaticAttr } from './shared'

/** What the island emitter borrows from the running `compileSsr()`. */
export interface IslandEmitter {
  use: (name: string) => string
  nextId: () => number
  markersAt: (offset: number) => boolean
}

/** One island element, its props serialized and its server children compiled. */
export interface IslandCall {
  island: IslandBinding
  tag: string
  /** The component as called, marked with its source line. */
  call: string
  start: number
  propEntries: string[]
  allStaticProps: boolean
  staticPropsObj: Record<string, unknown>
  hydrateExpr: string | undefined
  staticHydrate: string | undefined
  hasChildren: boolean
  childExpr: string
  childrenHaveAwait: boolean
}

export function emitIsland(em: IslandEmitter, c: IslandCall, parts: StringParts): void {
  const { island, tag, call, start, propEntries, allStaticProps, staticPropsObj, hydrateExpr, staticHydrate, hasChildren, childExpr, childrenHaveAwait } = c
  const propsCode = `{ ${propEntries.join(', ')} }`
  // The server children an island is handed render before it, outside its contexts and ids, as the browser never re-renders them.
  const slotVar = hasChildren ? `_c${em.nextId()}` : undefined
  const slotProp = slotVar === undefined ? '' : `children: ${slotVar}.prop`
  const callPropsCode = slotVar === undefined ? propsCode : `{ ${[...propEntries, slotProp].join(', ')} }`
  const withSlot = (expr: string): string => slotVar === undefined ? expr : `((${slotVar}) => ${expr})(${em.use('ssrSlot')}(${childExpr}))`
  const slotArg = slotVar === undefined ? '' : `, ${slotVar}`
  const resolvedHydrate = staticHydrate ?? (hydrateExpr === undefined ? island.defaultHydrate : undefined)
  const safeStaticProps = allStaticProps
    && !Object.hasOwn(staticPropsObj, '__k')
    && !Object.values(staticPropsObj).some(v => Object.is(v, -0))

  // Compile-time static island props fast path (only when not inside an island-reachable component and children don't contain direct `await`):
  // 0 JSON.stringify / Object.keys / escAttr at runtime, while still recording rendered islands & island ID scope!
  if (!em.markersAt(start) && !childrenHaveAwait && safeStaticProps && (hydrateExpr === undefined || staticHydrate !== undefined)) {
    const pAttr = Object.keys(staticPropsObj).length > 0
      ? ` p="${escapeStaticAttr(JSON.stringify(staticPropsObj))}"`
      : ''
    const hAttr = resolvedHydrate !== undefined && resolvedHydrate !== 'load'
      ? ` h="${escapeStaticAttr(resolvedHydrate)}"`
      : ''
    const openTag = `<kay-island c="${escapeStaticAttr(island.chunk)}"${pAttr}${hAttr}>`
    const hydrateArg = resolvedHydrate !== undefined ? JSON.stringify(resolvedHydrate) : 'undefined'
    const renderArg = resolvedHydrate === 'client'
      ? 'undefined'
      : `() => ${em.use('ssrChild')}(${call}(${callPropsCode}))`
    const expr = `${em.use('ssrIslandStatic')}(${JSON.stringify(island.chunk)}, ${JSON.stringify(openTag)}, ${renderArg}, ${hydrateArg}, ${JSON.stringify(tag)}${slotArg})`
    parts.pushExpr(withSlot(expr))
    return
  }

  const hydrateArg = hydrateExpr ?? (island.defaultHydrate !== undefined ? JSON.stringify(island.defaultHydrate) : 'undefined')
  if (!childrenHaveAwait && safeStaticProps && (hydrateExpr === undefined || staticHydrate !== undefined)) {
    parts.pushExpr(withSlot(`${em.use('ssrIsland')}(${JSON.stringify(island.chunk)}, () => ${em.use('ssrChild')}(${call}(${callPropsCode})), ${propsCode}, ${hydrateArg}, false, ${JSON.stringify(tag)}${slotArg})`))
    return
  }

  // Hoist dynamic island props / awaited children into a single binding so expressions evaluate once!
  const pVar = `_p${em.nextId()}`
  const argNames = [pVar]
  const argExprs = [propsCode]
  let callArg = pVar
  if (slotVar !== undefined) {
    argNames.push(slotVar)
    argExprs.push(`${em.use('ssrSlot')}(${childExpr})`)
    callArg = `{ ...${pVar}, ${slotProp} }`
  }
  let hArg = hydrateArg
  if (hydrateExpr !== undefined && staticHydrate === undefined) {
    const hVar = `_h${em.nextId()}`
    argNames.push(hVar)
    argExprs.push(hydrateExpr)
    hArg = hVar
  }
  parts.pushExpr(
    `((${argNames.join(', ')}) => ${em.use('ssrIsland')}(${JSON.stringify(island.chunk)}, () => ${em.use('ssrChild')}(${call}(${callArg})), ${pVar}, ${hArg}, false, ${JSON.stringify(tag)}${slotArg}))(${argExprs.join(', ')})`,
  )
}
