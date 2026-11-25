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

  test('a string handler, which would land in the HTML as an inline script', () => {
    refuses('<button onClick="save()">x</button>', /onClick="\.\.\." in Page\.tsx: pass a function, onClick=\{\(\) => \.\.\.\}/)
    refuses('<button onClick={\'save()\'}>x</button>', /pass a function/)
    refuses('<button onClick={`save()`}>x</button>', /pass a function/)
  })

  test('a handler that runs at render instead of on the event', () => {
    refuses('<button onClick={n.value++}>x</button>', /onClick runs n\.value\+\+ at render in Page\.tsx: write onClick=\{\(\) => n\.value\+\+\}/, 'const n = { value: 0 }')
    refuses('<button onClick={n.value = 1}>x</button>', /write onClick=\{\(\) => n\.value = 1\}/, 'const n = { value: 0 }')
    accepts('<button onClick={make()}>x</button>', 'const make = () => () => {}')
  })

  test('an event the DOM never fires, which binds a listener that never runs', () => {
    refuses('<div onDoubleClick={fn} />', /onDoubleClick in Page\.tsx: write onDblClick=\{\.\.\.\}/)
    refuses('<div onClickCapture={fn} />', /onClickCapture in Page\.tsx: kay has no capture props, call addEventListener\('click', fn, \{ capture: true \}\) in a ref/)
    refuses('<div onClik={fn} />', /onClik in Page\.tsx: no DOM event is named "clik"/)
    accepts('<my-widget onSelected={fn} />')
    accepts('<video onTimeUpdate={fn} onLoadedMetadata={fn} />')
    accepts('<form onSubmit={fn} onFormData={fn} />')
  })
})
