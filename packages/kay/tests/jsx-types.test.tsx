import { expect, test } from 'bun:test'
import { raw } from '../src/ssr/index'

// The compiler refuses these at build time; the types refuse them in the editor first. `tsc` fails on an unused @ts-expect-error.
test('JSX types refuse the spellings the compiler refuses', () => {
  const html = '<b>x</b>'
  const elements = [
    <div innerHTML={html} />,
    <div innerHTML={raw(html)} />,
    // @ts-expect-error React's object form: kay takes the string
    <div innerHTML={{ __html: html }} />,
    // @ts-expect-error React's name: write innerHTML
    <div dangerouslySetInnerHTML={{ __html: html }} />,
    // @ts-expect-error Solid's classList: pass one string to class
    <div classList={{ on: true }} />,
    // @ts-expect-error React's uncontrolled prop: write value
    <input defaultValue="x" />,
    // @ts-expect-error React's uncontrolled prop: write checked
    <input defaultChecked />,
    // @ts-expect-error React's name: write onDblClick
    <div onDoubleClick={() => {}} />,
  ]
  expect(elements).toHaveLength(8)
})
