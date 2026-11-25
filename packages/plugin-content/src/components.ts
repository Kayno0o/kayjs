// MDX-lite: literal prop parsing and embedded component expansion for Markdown bodies.

import type { MarkdownComponent, RenderMarkdownOptions } from './index'
import { raw, ssrRaw } from '@kayjs/kay/ssr'

// Safe recursive-descent JSON5-literal parser for embedded Markdown component props.
// Supports objects (unquoted/quoted keys, trailing commas), arrays (trailing commas),
// single/double-quoted strings, numbers (sign, float, exponent, hex), booleans, null, undefined.
// Rejects all arbitrary JS expressions (calls, operators, identifiers, templates, etc.).
function parseLiteralValue(src: string): unknown {
  let i = 0
  const len = src.length

  function skipWsAndComments(): void {
    while (i < len) {
      const ch = src[i]!
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
        i++
        continue
      }
      if (ch === '/' && src[i + 1] === '/') {
        i += 2
        while (i < len && src[i] !== '\n') i++
        continue
      }
      if (ch === '/' && src[i + 1] === '*') {
        i += 2
        const end = src.indexOf('*/', i)
        if (end === -1)
          throw new SyntaxError('Unterminated block comment')
        i = end + 2
        continue
      }
      break
    }
  }

  function parseString(quote: string): string {
    i++ // skip opening quote
    let out = ''
    while (i < len) {
      const ch = src[i]!
      if (ch === quote) {
        i++
        return out
      }
      if (ch === '\\') {
        i++
        if (i >= len)
          throw new SyntaxError('Unterminated string escape')
        const esc = src[i++]!
        switch (esc) {
          case 'n': out += '\n'; break
          case 'r': out += '\r'; break
          case 't': out += '\t'; break
          case 'b': out += '\b'; break
          case 'f': out += '\f'; break
          case 'v': out += '\v'; break
          case '0': out += '\0'; break
          case '\n': break
          case '\r': if (src[i] === '\n') i++; break
          case 'x': {
            const hex = src.slice(i, i + 2)
            if (!/^[0-9a-fA-F]{2}$/.test(hex))
              throw new SyntaxError('Invalid hex escape')
            out += String.fromCharCode(Number.parseInt(hex, 16))
            i += 2
            break
          }
          case 'u': {
            if (src[i] === '{') {
              const close = src.indexOf('}', i + 1)
              if (close === -1)
                throw new SyntaxError('Unterminated unicode escape')
              const hex = src.slice(i + 1, close)
              if (!/^[0-9a-fA-F]+$/.test(hex))
                throw new SyntaxError('Invalid unicode escape')
              out += String.fromCodePoint(Number.parseInt(hex, 16))
              i = close + 1
            }
            else {
              const hex = src.slice(i, i + 4)
              if (!/^[0-9a-fA-F]{4}$/.test(hex))
                throw new SyntaxError('Invalid unicode escape')
              out += String.fromCharCode(Number.parseInt(hex, 16))
              i += 4
            }
            break
          }
          default: out += esc; break
        }
        continue
      }
      if (ch === '\n' || ch === '\r')
        throw new SyntaxError('Unescaped newline in string')
      out += ch
      i++
    }
    throw new SyntaxError('Unterminated string literal')
  }

  function parseNumber(): number {
    const start = i
    if (src[i] === '+' || src[i] === '-')
      i++
    if (src[i] === '0' && (src[i + 1] === 'x' || src[i + 1] === 'X')) {
      i += 2
      const hexStart = i
      while (i < len && /[0-9a-fA-F]/.test(src[i]!)) i++
      if (i === hexStart)
        throw new SyntaxError('Invalid hex number')
      const sign = src[start] === '-' ? -1 : 1
      return sign * Number.parseInt(src.slice(hexStart, i), 16)
    }
    let hasDigits = false
    while (i < len && /[0-9]/.test(src[i]!)) {
      hasDigits = true
      i++
    }
    if (src[i] === '.') {
      i++
      while (i < len && /[0-9]/.test(src[i]!)) {
        hasDigits = true
        i++
      }
    }
    if (!hasDigits)
      throw new SyntaxError('Invalid number')
    if (src[i] === 'e' || src[i] === 'E') {
      i++
      if (src[i] === '+' || src[i] === '-')
        i++
      const expStart = i
      while (i < len && /[0-9]/.test(src[i]!)) i++
      if (i === expStart)
        throw new SyntaxError('Invalid exponent')
    }
    const num = Number(src.slice(start, i))
    if (Number.isNaN(num))
      throw new SyntaxError('Invalid number')
    return num
  }

  function parseArray(): unknown[] {
    i++ // skip '['
    const arr: unknown[] = []
    while (true) {
      skipWsAndComments()
      if (i >= len)
        throw new SyntaxError('Unterminated array')
      if (src[i] === ']') {
        i++
        return arr
      }
      arr.push(parseValue())
      skipWsAndComments()
      if (src[i] === ',') {
        i++
        continue
      }
      if (src[i] === ']') {
        i++
        return arr
      }
      throw new SyntaxError('Expected "," or "]" in array')
    }
  }

  function parseObject(): Record<string, unknown> {
    i++ // skip '{'
    const obj: Record<string, unknown> = {}
    while (true) {
      skipWsAndComments()
      if (i >= len)
        throw new SyntaxError('Unterminated object')
      if (src[i] === '}') {
        i++
        return obj
      }
      let key: string
      const ch = src[i]!
      if (ch === '"' || ch === '\'') {
        key = parseString(ch)
      }
      else if (/[A-Za-z_$]/.test(ch)) {
        const keyStart = i
        while (i < len && /[A-Za-z0-9_$]/.test(src[i]!)) i++
        key = src.slice(keyStart, i)
      }
      else {
        throw new SyntaxError('Expected object key')
      }
      skipWsAndComments()
      if (src[i] !== ':')
        throw new SyntaxError('Expected ":" after object key')
      i++
      const val = parseValue()
      if (key !== '__proto__' && key !== 'constructor' && key !== 'prototype') {
        Object.defineProperty(obj, key, {
          value: val,
          enumerable: true,
          writable: true,
          configurable: true,
        })
      }
      skipWsAndComments()
      if (src[i] === ',') {
        i++
        continue
      }
      if (src[i] === '}') {
        i++
        return obj
      }
      throw new SyntaxError('Expected "," or "}" in object')
    }
  }

  function parseValue(): unknown {
    skipWsAndComments()
    if (i >= len)
      throw new SyntaxError('Unexpected end of literal')
    const ch = src[i]!
    if (ch === '"' || ch === '\'')
      return parseString(ch)
    if (ch === '[')
      return parseArray()
    if (ch === '{')
      return parseObject()
    if (ch === '-' || ch === '+' || ch === '.' || (ch >= '0' && ch <= '9'))
      return parseNumber()
    if (src.startsWith('true', i) && !/[A-Za-z0-9_$]/.test(src[i + 4] ?? '')) {
      i += 4
      return true
    }
    if (src.startsWith('false', i) && !/[A-Za-z0-9_$]/.test(src[i + 5] ?? '')) {
      i += 5
      return false
    }
    if (src.startsWith('null', i) && !/[A-Za-z0-9_$]/.test(src[i + 4] ?? '')) {
      i += 4
      return null
    }
    if (src.startsWith('undefined', i) && !/[A-Za-z0-9_$]/.test(src[i + 9] ?? '')) {
      i += 9
      return undefined
    }
    throw new SyntaxError(`Unsupported non-literal expression at offset ${i}`)
  }

  const value = parseValue()
  skipWsAndComments()
  if (i !== len)
    throw new SyntaxError(`Unexpected trailing token at offset ${i}`)
  return value
}

// Parse JSX-style attributes inside embedded Markdown components: title="hi" count={42} rows={[...]} flag
function parseComponentProps(attrSrc: string): Record<string, unknown> {
  const props: Record<string, unknown> = {}
  let i = 0
  const len = attrSrc.length

  while (i < len) {
    while (i < len && /\s/.test(attrSrc[i]!)) i++
    if (i >= len) break

    const nameStart = i
    while (i < len && /[\w:-]/.test(attrSrc[i]!)) i++
    const name = attrSrc.slice(nameStart, i)
    if (!name) {
      i++
      continue
    }

    while (i < len && /\s/.test(attrSrc[i]!)) i++
    if (attrSrc[i] !== '=') {
      props[name] = true
      continue
    }
    i++ // skip '='
    while (i < len && /\s/.test(attrSrc[i]!)) i++

    const ch = attrSrc[i]
    if (ch === '"' || ch === '\'') {
      const quote = ch
      i++
      const valStart = i
      while (i < len && attrSrc[i] !== quote) {
        if (attrSrc[i] === '\\') i++
        i++
      }
      props[name] = attrSrc.slice(valStart, i)
      i++
    }
    else if (ch === '{') {
      let depth = 0
      const exprStart = i + 1
      let inStr: string | null = null
      while (i < len) {
        const c = attrSrc[i]!
        if (inStr !== null) {
          if (c === '\\') { i += 2; continue }
          if (c === inStr) inStr = null
        }
        else {
          if (c === '"' || c === '\'' || c === '`') inStr = c
          else if (c === '{') depth++
          else if (c === '}') {
            depth--
            if (depth === 0) break
          }
        }
        i++
      }
      const expr = attrSrc.slice(exprStart, i).trim()
      i++ // skip closing '}'
      try {
        props[name] = parseLiteralValue(expr)
      }
      catch {
        // Reject/ignore arbitrary non-literal JS expressions
      }
    }
  }
  return props
}

// Find the end of an opening JSX tag (`>` or `/>`), respecting strings and balanced `{...}` expressions.
function findTagEnd(src: string, start: number): { end: number, selfClosing: boolean } | undefined {
  let i = start
  const len = src.length
  let braceDepth = 0
  let inStr: string | null = null

  while (i < len) {
    const c = src[i]!
    if (inStr !== null) {
      if (c === '\\') { i += 2; continue }
      if (c === inStr) inStr = null
      i++
      continue
    }
    if (c === '"' || c === '\'' || c === '`') {
      inStr = c
      i++
      continue
    }
    if (c === '{') {
      braceDepth++
      i++
      continue
    }
    if (c === '}') {
      braceDepth = Math.max(0, braceDepth - 1)
      i++
      continue
    }
    if (braceDepth === 0) {
      if (c === '/' && src[i + 1] === '>')
        return { end: i + 2, selfClosing: true }
      if (c === '>')
        return { end: i + 1, selfClosing: false }
    }
    i++
  }
  return undefined
}

export function expandComponents(
  md: string,
  components: Record<string, MarkdownComponent>,
  options: RenderMarkdownOptions,
  slots: string[],
  slotPrefix: string,
  renderMarkdown: (md: string, options: RenderMarkdownOptions) => { html: string },
): string {
  const names = Object.keys(components)
  if (names.length === 0)
    return md

  let out = ''
  let i = 0
  const len = md.length

  while (i < len) {
    const lt = md.indexOf('<', i)
    if (lt === -1) {
      out += md.slice(i)
      break
    }

    const match = /^<([A-Z][\w]*)(?=[\s/>])/.exec(md.slice(lt))
    if (!match || !(match[1]! in components)) {
      out += md.slice(i, lt + 1)
      i = lt + 1
      continue
    }

    const tagName = match[1]!
    const tagEnd = findTagEnd(md, lt + match[0].length)
    if (!tagEnd) {
      out += md.slice(i, lt + 1)
      i = lt + 1
      continue
    }

    out += md.slice(i, lt)
    const attrSrc = md.slice(lt + match[0].length, tagEnd.selfClosing ? tagEnd.end - 2 : tagEnd.end - 1)
    const props = parseComponentProps(attrSrc)
    let afterIndex = tagEnd.end

    if (!tagEnd.selfClosing) {
      // Find matching closing </TagName> with nesting depth
      const closeTag = `</${tagName}>`
      const openRe = new RegExp(`<${tagName}(?=[\\s/>])|</${tagName}>`, 'g')
      openRe.lastIndex = tagEnd.end
      let depth = 1
      let closeIdx = -1
      let m: RegExpExecArray | null
      while ((m = openRe.exec(md)) !== null) {
        if (m[0] === closeTag) {
          depth--
          if (depth === 0) {
            closeIdx = m.index
            break
          }
        }
        else {
          const innerEnd = findTagEnd(md, m.index + m[0].length)
          if (innerEnd && !innerEnd.selfClosing)
            depth++
        }
      }
      if (closeIdx !== -1) {
        const innerMd = md.slice(tagEnd.end, closeIdx).trim()
        const innerRendered = renderMarkdown(innerMd, options)
        props.children = raw(innerRendered.html.trim())
        afterIndex = closeIdx + closeTag.length
      }
    }

    if (options.locale !== undefined && props.locale === undefined)
      props.locale = options.locale

    const renderedHtml = ssrRaw(components[tagName]!(props))
    const slotIdx = slots.length
    slots.push(renderedHtml)
    out += `\n\n<div data-kay-md-slot="${slotPrefix}${slotIdx}"></div>\n\n`
    i = afterIndex
  }

  return out
}
