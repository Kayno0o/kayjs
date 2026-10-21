// The text between a function's parentheses, or its lone arrow parameter: its first character is all that is read.
const PARAMETERS = /^(?:async\s+)?(?:function[^(]*|[\w$]+\s*)?\(\s*(.?)/
const NATIVE = '[native code]'

type Shape = 'event' | 'positional' | { keys: string[] }

const shapes = new WeakMap<object, Shape>()

// The top-level names a destructuring pattern reads, `{ user, profile: p = 1, ...rest }` giving `user` and `profile`; undefined when it reads a nested key or a computed one it cannot name.
function patternKeys(source: string): string[] | undefined {
  const start = source.indexOf('{')
  const keys: string[] = []
  let depth = 0
  let piece = ''

  for (let at = start; at < source.length; at++) {
    const char = source[at]!

    if (char === '{' || char === '[' || char === '(') {
      depth++

      if (depth === 1)
        continue
    }
    else if (char === '}' || char === ']' || char === ')') {
      depth--

      if (depth === 0)
        break
    }

    if (depth === 1 && char === ',') {
      keys.push(piece)
      piece = ''
    }
    else if (depth === 1 || piece === '') {
      piece += char
    }
  }

  keys.push(piece)

  const named = keys.map(key => key.trim()).filter(key => key !== '' && !key.startsWith('...')).map(key => (/^[\w$]+/).exec(key)?.[0])

  return named.every(key => key !== undefined) ? named : undefined
}

function shapeOf(hook: (...args: never[]) => unknown): Shape {
  const source = hook.toString()

  if (hook.length >= 2)
    return 'positional'

  // A mock, a bound function or a wrapper hides its parameters: it is the new shape, as the old one cannot be told.
  if (source.includes(NATIVE))
    return 'event'

  const first = PARAMETERS.exec(source)?.[1]

  // A rest or default parameter has no `length`, and a name with no parentheses is a lone parameter of the old shape.
  if (first === undefined || first === ')')
    return first === ')' ? 'event' : 'positional'

  if (first !== '{')
    return 'positional'

  const keys = patternKeys(source.slice(source.indexOf('{')))

  return keys === undefined ? 'event' : { keys }
}

// Calls an `on*` hook with its one event object, or with `legacy` as positional arguments when it still has its old shape: two or more parameters, a rest or default one, or a lone one that is not destructured (`(user) => ...`) or destructures a field the event has not (`({ id }) => ...`). This lets the old shape keep working until 1.73, so an app writes `({ user })` to move over.
export function callHook<Result>(hook: (...args: never[]) => Result, event: object, legacy: readonly unknown[]): Result {
  const call = hook as (...args: unknown[]) => Result
  let shape = shapes.get(hook)

  if (shape === undefined) {
    shape = shapeOf(hook)
    shapes.set(hook, shape)
  }

  const asEvent = shape === 'event' || (typeof shape === 'object' && shape.keys.every(key => key in event))

  return asEvent ? call(event) : call(...legacy)
}
