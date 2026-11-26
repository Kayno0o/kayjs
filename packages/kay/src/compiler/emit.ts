// Static tables and the module header of a DOM-compiled file.

export const SVG_CHILD_TAGS = new Set([
  'path', 'circle', 'rect', 'line', 'polyline', 'polygon', 'ellipse',
  'g', 'defs', 'use', 'text', 'tspan', 'textPath', 'clipPath', 'mask',
  'linearGradient', 'radialGradient', 'stop', 'pattern', 'symbol', 'image',
  'marker', 'filter', 'feBlend', 'feColorMatrix', 'feComponentTransfer',
  'feComposite', 'feConvolveMatrix', 'feDiffuseLighting', 'feDisplacementMap',
  'feDistantLight', 'feDropShadow', 'feFlood', 'feFuncA', 'feFuncB', 'feFuncG',
  'feFuncR', 'feGaussianBlur', 'feImage', 'feMerge', 'feMergeNode',
  'feMorphology', 'feOffset', 'fePointLight', 'feSpecularLighting',
  'feSpotLight', 'feTile', 'feTurbulence', 'foreignObject', 'animate',
  'animateMotion', 'animateTransform', 'set', 'mpath', 'desc', 'metadata', 'switch',
])

export const DELEGATED_EVENTS = new Set([
  'beforeinput', 'click', 'dblclick', 'focusin', 'focusout',
  'input', 'keydown', 'keyup', 'mousedown', 'mouseup',
  'pointerdown', 'pointerup', 'touchstart', 'touchend',
])

// Helpers kept out of the dom core, which every island loads: a page pays for them only when one of its islands binds them.
const ATTR_HELPERS = ['setAttr', 'setClass', 'setProp', 'setStyle']
const CLAIM_HELPERS = ['eachStatic']
const EXTRA_HELPERS = ['fragInsert', 'insert', 'mergeProps', 'omit', 'propDefault', 'setInnerHtml', 'show', 'spread']

function takeHelpers(used: Set<string>, names: readonly string[]): string[] {
  return names.filter(name => used.delete(name))
}

/** The import lines, hoisted templates and delegation call a compiled module starts with. Marks the helpers it needs in `used`. */
export function moduleHeader(used: Set<string>, templates: readonly { name: string, html: string, isSvg?: boolean }[], delegatedEvents: ReadonlySet<string>): string {
  let header = ''
  if (templates.length > 0)
    used.add('template')
  if (delegatedEvents.size > 0)
    used.add('delegate')

  if (used.size > 0) {
    const hasLoop = used.delete('loop')
    const usedAttrs = takeHelpers(used, ATTR_HELPERS)
    const usedClaims = takeHelpers(used, CLAIM_HELPERS)
    const usedExtras = takeHelpers(used, EXTRA_HELPERS)
    for (const [names, module] of [[[...used].sort(), 'dom'], [usedAttrs, 'dom-attrs'], [usedClaims, 'dom-claim'], [usedExtras, 'dom-extras']] as const) {
      if (names.length > 0)
        header += `import { ${names.map(name => `${name} as __${name}`).join(', ')} } from '@kayjs/kay/internal/${module}';\n`
    }
    if (hasLoop)
      header += `import { loop as __loop } from '@kayjs/kay/internal/dom-loop';\n`
  }
  for (const t of templates)
    header += `const ${t.name} = /* @__PURE__ */ __template(${JSON.stringify(t.html)}${t.isSvg ? ', true' : ''});\n`
  if (delegatedEvents.size > 0)
    header += `__delegate(${JSON.stringify([...delegatedEvents].sort())});\n`
  return header
}

export interface WalkItem { parentVar: string, index: number, varName: string }

/** Emits the `const _eN = ...` sibling walks from each parent to the nodes the ops touch, skipping the text and range slots the server brackets with markers. */
export function emitWalkStatements(
  rootVar: string,
  walkPlan: readonly WalkItem[],
  textSlotsByParent: ReadonlyMap<string, ReadonlySet<number>>,
  rangeSlotsByParent: ReadonlyMap<string, ReadonlySet<number>>,
  use: (name: string) => string,
): string[] {
    // Emit parent->child sibling walks grouped by parentVar (breadth-first / parent-first order)
    const walkStmts: string[] = []
    const byParent = new Map<string, { index: number, varName: string }[]>()
    for (const item of walkPlan) {
      let arr = byParent.get(item.parentVar)
      if (arr === undefined) {
        arr = []
        byParent.set(item.parentVar, arr)
      }
      arr.push({ index: item.index, varName: item.varName })
    }

    const emittedParents = new Set<string>([rootVar])
    const queue = [rootVar]
    while (queue.length > 0) {
      const pVar = queue.shift()!
      const list = byParent.get(pVar)
      if (list === undefined)
        continue
      list.sort((a, b) => a.index - b.index)

      const tSlots = textSlotsByParent.get(pVar)
      const rSlots = rangeSlotsByParent.get(pVar)
      let prevVar: string | undefined
      let prevIdx = -1
      for (const { index, varName } of list) {
        let expr: string
        let pos: number
        if (prevVar === undefined) {
          expr = `${pVar}.firstChild`
          pos = 0
        }
        else {
          expr = prevVar
          pos = prevIdx
        }
        while (pos < index) {
          if (tSlots?.has(pos + 1) && pos + 2 <= index) {
            expr = `${use('skipText')}(${expr})`
            pos += 2
          }
          else if (rSlots?.has(pos + 1)) {
            expr = `${use('skipRange')}(${expr})`
            pos += 1
          }
          else {
            expr = `${expr}.nextSibling`
            pos += 1
          }
        }
        walkStmts.push(`const ${varName} = ${expr};`)
        prevVar = varName
        prevIdx = index
        if (!emittedParents.has(varName)) {
          emittedParents.add(varName)
          queue.push(varName)
        }
      }
    }
  return walkStmts
}
