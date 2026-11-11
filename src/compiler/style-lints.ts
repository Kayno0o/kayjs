import type { Diagnostic, ElementNode, KayFile } from './ast'
import { elementsIn } from './ast'
import { blankComments, pseudoElementAt, selectorList, selectorParts, styleRules } from './scoped-style'

const WHITESPACE = /\s+/
const STRING_OR_COMMENT = /\/\/[^\n]*|\/\*[\s\S]*?\*\/|'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`/g
const WORD = /[.*+?^${}()|[\]\\]/g
const ROOT_PSEUDO = /(?<![\w-]):root(?![\w-])/
const ROOT_ELEMENT = /^(?:html|body)(?![\w-])/i
const TYPE = /^(?:\*|[a-z][\w-]*)/i
const NAMED = /([.#])((?:\\.|[\w\-\P{ASCII}])+)/gu
const HEX_ESCAPE = /\\[\da-f]/i
const ESCAPE = /\\(.)/g

// What a compound selector needs of an element: the part of it that is this component's, with pseudo-classes, brackets and the arguments of a pseudo-class left out, as none of them requires a class, an id or a tag to exist.
interface Wanted {
  type: string | undefined
  classes: string[]
  ids: string[]
  root: boolean
  // A name written with a hex escape, which is not compared.
  opaque: boolean
}

function plain(compound: string): string {
  let out = ''
  let depth = 0

  for (let i = 0; i < compound.length; i++) {
    const char = compound[i]!

    if (char === '\\') {
      if (depth === 0)
        out += compound.slice(i, i + 2)

      i++
    }
    else if (char === '"' || char === '\'') {
      i = compound.indexOf(char, i + 1)

      if (i === -1)
        break
    }
    else if (char === '(' || char === '[') {
      depth++
    }
    else if (char === ')' || char === ']') {
      depth = Math.max(depth - 1, 0)
    }
    else if (depth === 0 && char !== '&') {
      out += char
    }
  }

  return out
}

function wantedOf(compound: string): Wanted {
  const text = plain(compound)
  const names = [...text.matchAll(NAMED)].map(match => ({ id: match[1] === '#', name: match[2]! }))

  return {
    type: TYPE.exec(text)?.[0].toLowerCase(),
    classes: names.filter(name => !name.id).map(name => name.name.replaceAll(ESCAPE, '$1')),
    ids: names.filter(name => name.id).map(name => name.name.replaceAll(ESCAPE, '$1')),
    root: ROOT_PSEUDO.test(text) || ROOT_ELEMENT.test(text),
    opaque: names.some(name => HEX_ESCAPE.test(name.name)),
  }
}

// What an element of the template may carry: `undefined` for a tag or a set of names it cannot say, as a component call's tag or the classes a spread or an expression sets.
interface Present {
  tag: string | undefined
  classes: Set<string>
  anyClass: boolean
  id: string | undefined
  anyId: boolean
}

function presentOn(element: ElementNode, source: string): Present {
  const classes = new Set(element.classes.flatMap(span => source.slice(span.start, span.end).split(WHITESPACE)))
  let anyClass = false
  let anyId = false
  let id = element.id ? source.slice(element.id.start, element.id.end) : undefined

  for (const attribute of element.attributes) {
    if (attribute.kind === 'spread') {
      anyClass = true
      anyId = true

      continue
    }

    const name = source.slice(attribute.name.start, attribute.name.end)

    if (name === 'class' && attribute.kind === 'static') {
      for (const token of attribute.text.split(WHITESPACE)) {
        classes.add(token)
      }
    }
    else if (name === 'class' || name.startsWith('class:') || name === 'part') {
      anyClass = true
    }
    else if (name === 'id' && attribute.kind === 'static') {
      id = attribute.text.trim()
    }
    else if (name === 'id') {
      anyId = true
    }
  }

  return { tag: element.component ? undefined : element.name.toLowerCase(), classes, anyClass, id, anyId }
}

// Whether some element of the template may match the compound, or the code of the component names the class or id, which it may set on an element itself.
function matches(wanted: Wanted, elements: Present[], mentioned: (name: string) => boolean): boolean {
  if (wanted.opaque || (wanted.type === undefined && wanted.classes.length === 0 && wanted.ids.length === 0))
    return true

  return elements.some(element => (wanted.type === undefined || wanted.type === '*' || element.tag === undefined || element.tag === wanted.type)
    && wanted.ids.every(id => element.anyId || element.id === id || mentioned(id))
    && wanted.classes.every(name => element.anyClass || element.classes.has(name) || mentioned(name)))
}

// The lints of a `--- style` fence: a rule no element of the template can match, and a `:root`, `html` or `body` rule, which the scope attribute keeps from matching.
export function styleLints(file: KayFile): Diagnostic[] {
  if (file.style === undefined)
    return []

  const { source } = file
  const css = blankComments(source.slice(file.style.start, file.style.end))
  const code = [file.script, file.server, file.module].flatMap(span => span ? (source.slice(span.start, span.end).match(STRING_OR_COMMENT) ?? []).filter(token => !token.startsWith('/')) : []).join('\n')
  const mentions = new Map<string, boolean>()
  const mentioned = (name: string) => {
    let found = mentions.get(name)

    if (found === undefined) {
      found = new RegExp(`(?<![\\w-])${name.replaceAll(WORD, '\\$&')}(?![\\w-])`).test(code)
      mentions.set(name, found)
    }

    return found
  }
  const elements = [...elementsIn(file.template)].filter(element => element.outlet === undefined).map(element => presentOn(element, source))
  const found: Diagnostic[] = []

  for (const rule of styleRules(css)) {
    for (const selector of selectorList(rule.selector)) {
      const { parts, target } = selectorParts(selector.text)
      const part = parts[target]

      if (part === undefined)
        continue

      const start = file.style.start + rule.start + selector.start
      const wanted = wantedOf(part.ownText)

      if (wanted.root) {
        const from = start + part.start
        const wrapped = part.text === part.ownText ? part.text.slice(0, pseudoElementAt(part.text)) : undefined

        found.push({
          start,
          end: start + selector.text.length,
          code: 'unreachable-selector',
          message: `\`${part.ownText.trim()}\` can never match in a \`--- style\` fence`,
          note: 'kay ends each selector on the component\'s scope attribute, and `html`, `body` and `:root` carry none',
          help: 'write the element as `:global(...)`, or style it from a stylesheet the page imports',
          ...wrapped === undefined || wrapped === '' ? {} : { fixes: [{ title: `Write \`:global(${wrapped})\``, safe: false, edits: [{ start: from, end: from + wrapped.length, text: `:global(${wrapped})` }] }] },
          checkOnly: true,
        })
      }
      else if (!matches(wanted, elements, mentioned)) {
        found.push({
          start,
          end: start + selector.text.length,
          code: 'unused-selector',
          message: `\`${selector.text}\` matches no element this template writes`,
          note: 'a rule in a `--- style` fence reaches the elements of its own template, and none has these classes, id or tag',
          help: 'remove the rule, or write the part another component renders as `:global(...)`',
          checkOnly: true,
        })
      }
    }
  }

  return found
}
