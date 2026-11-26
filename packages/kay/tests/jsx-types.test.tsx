import { expect, test } from 'bun:test'
import { action } from '../src/server/action'
import { raw } from '../src/ssr/index'

declare module '@kayjs/kay/jsx-runtime' {
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
    // @ts-expect-error form is only valid on form-associated controls
    <div form="filters" />,
    // @ts-expect-error React camelCase SVG attribute
    <svg><path strokeWidth="2" /></svg>,
    // Form-associated controls accept the `form` content attribute (#3619)
    <button form="filters" type="submit">Apply</button>,
    <input form="filters" name="q" />,
    <select form="filters" name="sort" />,
    <textarea form="filters" name="note" />,
    <fieldset form="filters" />,
    <output form="filters" />,
    <object form="filters" />,
    // Valid HTML + SVG + data-*/aria-* + typed currentTarget & ref (zero casts!)
    <div data-custom="1" aria-label="box" onScroll={() => {}} onWheel={() => {}} onDragStart={() => {}} onTouchStart={() => {}} onToggle={() => {}} />,
    <input
      type="text"
      ref={(el) => { inputRef = el }}
      onInput={(e) => { inputVal = e.currentTarget.value }}
    />,
    <svg ref={(el) => { svgRef = el }} viewBox="0 0 10 10"><path d="M0 0" stroke-width="2" /></svg>,
    // Async component typechecks as JSX tag (and accepts $hydrate)
    <AsyncBanner title="hi" $hydrate="visible" />,
    // Custom element registered via module augmentation
    <my-widget label="ok" onSelected={() => {}} />,
    // #3630: tightened JSX types — camelCase aria, DOM-only props, branded form actions, $hydrate on elements, void children, iframe.srcdoc
    // @ts-expect-error camelCase ariaLabel is rejected in favor of aria-label
    <div ariaLabel="box" />,
    // @ts-expect-error DOM-only property httpEquiv is rejected in favor of http-equiv
    <meta httpEquiv="refresh" content="5" />,
    // @ts-expect-error DOM-only property acceptCharset is rejected in favor of accept-charset
    <form acceptCharset="utf-8" />,
    // @ts-expect-error DOM-only property defaultSelected is rejected
    <option defaultSelected value="a">A</option>,
    // @ts-expect-error DOM-only property currentTime is rejected
    <video currentTime={5} />,
    // @ts-expect-error DOM-only hyperlink getter pathname is rejected
    <a href="/ok" pathname="/bad">x</a>,
    // @ts-expect-error plain function is rejected on form action (only string or branded server action)
    <form action={() => {}} />,
    // @ts-expect-error plain function is rejected on button formaction
    <button formaction={() => {}} />,
    // @ts-expect-error $hydrate is not allowed on intrinsic HTML elements
    <div $hydrate="visible" />,
    // @ts-expect-error $hydrate is not allowed on intrinsic SVG elements
    <svg $hydrate="idle" />,
    // @ts-expect-error void elements cannot have children
    <img src="/a.png">nope</img>,
    // @ts-expect-error void elements cannot have children
    <input>nope</input>,
    // @ts-expect-error void elements cannot have children
    <br>nope</br>,
    // @ts-expect-error iframe srcdoc is blocked by Kay
    <iframe srcdoc="<p>x</p>" />,
    // Valid branded server action & string URL on form/button
    <form action={action(async () => 'ok')} method="post"><button formaction={action(async () => 'ok')}>Go</button></form>,
    <form action="/submit" method="post"><button formaction="/alt">Alt</button></form>,
    <meta http-equiv="refresh" content="5" />,
    <form accept-charset="utf-8" />,
  ]

  expect(elements.length).toBeGreaterThan(10)
  expect(inputRef).toBeUndefined()
  expect(svgRef).toBeUndefined()
  expect(inputVal).toBe('')
})
