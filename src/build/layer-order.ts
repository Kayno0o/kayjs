const LAYER_STATEMENT = /^@layer\s[^;{}]*;/
const LEADING_CHARSET = /^@charset\s+"[^"]*";/

// The end of the comment or string starting at `at`, or `at` itself when neither starts there.
function skipped(css: string, at: number): number {
  if (css.startsWith('/*', at)) {
    const end = css.indexOf('*/', at + 2)

    return end === -1 ? css.length : end + 2
  }

  const quote = css[at]

  if (quote !== '"' && quote !== '\'')
    return at

  let index = at + 1

  while (index < css.length && css[index] !== quote)
    index += css[index] === '\\' ? 2 : 1

  return index + 1
}

// A stylesheet a component imports lands in the bundle before the app's own, so its `@layer components { }` would fix the layer order ahead of the app's `@layer theme, base, components, utilities;` and put it under every later layer: the top-level order statements move to the start, in the order written, where the app meant them to stand.
export function hoistLayerOrder(css: string): string {
  const statements: { at: number, text: string }[] = []
  let depth = 0
  let blockSeen = false
  let late = false
  let index = 0

  while (index < css.length) {
    const next = skipped(css, index)

    if (next !== index) {
      index = next

      continue
    }

    const char = css[index]!

    if (char === '{') {
      depth++
      blockSeen = true
    }
    else if (char === '}') {
      depth = Math.max(0, depth - 1)
    }
    else if (char === '@' && depth === 0) {
      const text = LAYER_STATEMENT.exec(css.slice(index, index + 2048))?.[0]

      if (text !== undefined) {
        statements.push({ at: index, text })
        late ||= blockSeen
        index += text.length

        continue
      }
    }

    index++
  }

  if (!late)
    return css

  let rest = ''
  let from = 0

  for (const { at, text } of statements) {
    rest += css.slice(from, at)
    from = at + text.length
  }

  rest += css.slice(from)

  const charset = LEADING_CHARSET.exec(rest)?.[0] ?? ''

  return charset + statements.map(({ text }) => text).join('') + rest.slice(charset.length)
}
