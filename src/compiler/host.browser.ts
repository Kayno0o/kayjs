// The browser's stand-ins for `host.ts`: the playground compiles one file in memory, so nothing reads a project or runs Bun.
import traverse from '@babel/traverse'

// Bundled with the page, whose chunk loads when the playground opens.
export function loadTraverse(): typeof traverse {
  return (traverse as unknown as { default?: typeof traverse }).default ?? traverse
}

export function browserGlobals(): ReadonlySet<string> {
  return new Set()
}

// FNV-1a over the UTF-16 units, 64 bits: a scoped style's attribute only has to differ from another module's, so it need not match Bun.hash.
export function hash(text: string): string {
  let state = 0xCBF29CE484222325n

  for (let i = 0; i < text.length; i++)
    state = BigInt.asUintN(64, (state ^ BigInt(text.charCodeAt(i))) * 0x100000001B3n)

  return state.toString(36)
}

export function cwd(): string {
  return '/'
}

export function markdownHtml(): string {
  throw new Error('A markdown block needs Bun\'s Markdown parser, which the playground lacks')
}

export function markdownEntity(): undefined {
  return undefined
}

export function iconSetsOf(): undefined {
  return undefined
}
