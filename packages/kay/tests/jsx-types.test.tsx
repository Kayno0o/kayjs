import { expect, test } from 'bun:test'
import { raw } from '../src/ssr/index'

declare module 'kay/jsx-runtime' {
  namespace JSX {
    interface CustomElements {
      'my-widget': {
        label?: string | undefined
        onSelected?: ((e: CustomEvent<string>) => void) | undefined
      }
    }
  }
}

async function AsyncBanner({ title }: { title: string }) {
  return <section><h1>{title}</h1></section>
}

// The compiler refuses these at build time; the types refuse them in the editor first. `tsc` fails on an unused @ts-expect-error.
test('JSX types refuse unknown tags, unknown attrs, React/Solid spellings, and type currentTarget, ref, events, async & custom elements', () => {
  const html = '<b>x</b>'
  let inputRef: HTMLInputElement | undefined
  let svgRef: SVGSVGElement | undefined
  let inputVal = ''

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
    // @ts-expect-error Unknown HTML tag typo
    <dvi />,
    // @ts-expect-error Unknown attribute typo
    <div clas="a" />,
    // @ts-expect-error Unknown event prop typo
    <button onClik={() => {}} />,
    // @ts-expect-error href is not valid on <div>
    <div href="/nope" />,
    // @ts-expect-error React camelCase SVG attribute
    <svg><path strokeWidth="2" /></svg>,
    // Valid HTML + SVG + data-*/aria-* + typed currentTarget & ref (zero casts!)
    <div data-custom="1" aria-label="box" onScroll={() => {}} onWheel={() => {}} onDragStart={() => {}} onTouchStart={() => {}} onToggle={() => {}} />,
    <input
      type="text"
      ref={(el) => { inputRef = el }}
      onInput={(e) => { inputVal = e.currentTarget.value }}
    />,
    <svg ref={(el) => { svgRef = el }} viewBox="0 0 10 10"><path d="M0 0" stroke-width="2" /></svg>,
    // Async component typechecks as JSX tag
    <AsyncBanner title="hi" />,
    // Custom element registered via module augmentation
    <my-widget label="ok" onSelected={() => {}} />,
  ]

  expect(elements.length).toBeGreaterThan(10)
  expect(inputRef).toBeUndefined()
  expect(svgRef).toBeUndefined()
  expect(inputVal).toBe('')
})
