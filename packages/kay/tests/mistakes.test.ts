import { describe, expect, test } from 'bun:test'
import { compileDom, compileSsr } from '../src/compiler/index'

// Each mistake must fail both compile targets with the same message naming the fix.
function refuses(jsx: string, message: RegExp, setup = ''): void {
  const page = `${setup}\nexport default function Page() { const fn = () => {}; return ${jsx} }`
  expect(() => compileSsr('Page.tsx', page)).toThrow(message)
  expect(() => compileDom('Page.tsx', page)).toThrow(message)
}

function accepts(jsx: string, setup = ''): void {
  const page = `${setup}\nexport default function Page() { const fn = () => {}; return ${jsx} }`
  expect(() => compileSsr('Page.tsx', page)).not.toThrow()
  expect(() => compileDom('Page.tsx', page)).not.toThrow()
}

describe('kay refuses mistakes carried over from other frameworks', () => {
  test('a lowercase or namespaced event prop, which binds nothing', () => {
    refuses('<button onclick={fn}>x</button>', /onclick in Page\.tsx: write onClick=\{\.\.\.\}/)
    refuses('<input onkeydown={fn} />', /write onKeyDown=/)
    refuses('<button on:click={fn}>x</button>', /on:click in Page\.tsx: write onClick=/)
    accepts('<button onClick={fn}>x</button>')
    accepts('<Button onclick={fn} />', 'const Button = (p: any) => <button>{p.x}</button>')
  })
})
