/** @jsxImportSource @kayjs/kay */
// Zero-JS static & native-platform primitives (`0 KB` client JS!).
// Emit only semantic `data-ui`, `data-part`, `data-variant`, `data-tone`, `data-layout` attributes.

import type { Html, KayChild } from '@kayjs/kay'
import { createContext, provideContext, useContext } from '@kayjs/kay'

function escAttr(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

export type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger'
export type ButtonVariant = 'solid' | 'outline' | 'ghost'
export type Size = 'sm' | 'md' | 'lg'

interface BoxProps {
  class?: string | undefined
  children?: KayChild | undefined
  [attr: string]: unknown
}

export interface ButtonProps {
  variant?: ButtonVariant | undefined
  tone?: Tone | undefined
  size?: Size | undefined
  href?: string | undefined
  type?: 'button' | 'submit' | 'reset' | undefined
  disabled?: boolean | undefined
  class?: string | undefined
  children?: KayChild | undefined
  [attr: string]: unknown
}

function restProps(props: Record<string, unknown>, skip: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(props)) {
    if (k !== 'children' && !skip.includes(k))
      out[k] = props[k]
  }
  return out
}

export function Button(props: ButtonProps) {
  const rest = restProps(props as unknown as Record<string, unknown>, ['variant', 'tone', 'size', 'href', 'type', 'disabled', 'class'])
  if (props.href !== undefined) {
    return (
      <a data-ui="button" data-variant={props.variant ?? 'solid'} data-tone={props.tone} data-size={props.size ?? 'md'} href={props.href} class={props.class} {...rest}>
        {props.children}
      </a>
    )
  }
  return (
    <button data-ui="button" data-variant={props.variant ?? 'solid'} data-tone={props.tone} data-size={props.size ?? 'md'} type={props.type ?? 'button'} disabled={props.disabled} class={props.class} {...rest}>
      {props.children}
    </button>
  )
}

export function Badge(props: BoxProps & { tone?: Tone | undefined }) {
  const rest = restProps(props, ['tone', 'class'])
  return <span data-ui="badge" data-tone={props.tone} class={props.class} {...rest}>{props.children}</span>
}

export function Notice(props: BoxProps & { tone?: Tone | undefined, role?: 'status' | 'alert' | 'note' | undefined }) {
  const rest = restProps(props, ['tone', 'role', 'class'])
  return <div data-ui="notice" data-tone={props.tone} role={props.role ?? 'status'} class={props.class} {...rest}>{props.children}</div>
}

export function Card(props: BoxProps) {
  const rest = restProps(props, ['class'])
  return <section data-ui="card" class={props.class} {...rest}>{props.children}</section>
}

export function CardHeader(props: BoxProps) {
  const rest = restProps(props, ['class'])
  return <header data-part="header" class={props.class} {...rest}>{props.children}</header>
}

export function CardBody(props: BoxProps) {
  const rest = restProps(props, ['class'])
  return <div data-part="body" class={props.class} {...rest}>{props.children}</div>
}

export function CardFooter(props: BoxProps) {
  const rest = restProps(props, ['class'])
  return <footer data-part="footer" class={props.class} {...rest}>{props.children}</footer>
}

/** Zero-JS native `<details>` accordion (`name` enables exclusive mode natively in the browser). */
export function Accordion(props: BoxProps) {
  const rest = restProps(props, ['class'])
  return <div data-ui="accordion" class={props.class} {...rest}>{props.children}</div>
}

export function AccordionItem(props: { title: string, group?: string | undefined, open?: boolean | undefined, children?: KayChild | undefined, [attr: string]: unknown }) {
  const rest = restProps(props, ['title', 'group', 'open'])
  return (
    <details name={props.group} open={props.open} {...rest}>
      <summary data-part="trigger">{props.title}</summary>
      <div data-part="content">{props.children}</div>
    </details>
  )
}

/** Zero-JS form field wrapper that auto-wires `for`, `aria-describedby`, `aria-invalid`, hints, and action errors. */
export interface FieldProps {
  id: string
  label: string
  hint?: string | undefined
  error?: string | undefined
  required?: boolean | undefined
  class?: string | undefined
  children?: KayChild | undefined
}

export interface FieldControlWiring {
  id: string
  describedBy: string | undefined
  invalid: boolean
  required: boolean
}

export const FieldContext = createContext<FieldControlWiring | undefined>(undefined)

export function useFieldContext(): FieldControlWiring | undefined {
  return useContext(FieldContext)
}

function mergeTokenAttr(existing: string | null | undefined, addition: string): string {
  const tokens = (existing ?? '').split(/\s+/).filter(Boolean)
  for (const tok of addition.split(/\s+/).filter(Boolean)) {
    if (!tokens.includes(tok))
      tokens.push(tok)
  }
  return tokens.join(' ')
}

interface ScannedTag {
  start: number
  end: number
  tag: string
  rawAttrs: string
  selfClose: string
}

/** Quote-aware HTML opening tag scanner so `>` inside attribute values (e.g. `placeholder="x > 0"`) never truncates a tag. */
function scanOpeningTags(html: string): ScannedTag[] {
  const tags: ScannedTag[] = []
  const len = html.length
  let i = 0
  while (i < len) {
    const lt = html.indexOf('<', i)
    if (lt === -1)
      break
    const next = html.charCodeAt(lt + 1)
    if (!((next >= 65 && next <= 90) || (next >= 97 && next <= 122))) {
      i = lt + 1
      continue
    }
    let nameEnd = lt + 2
    while (nameEnd < len) {
      const ch = html.charCodeAt(nameEnd)
      if ((ch >= 65 && ch <= 90) || (ch >= 97 && ch <= 122) || (ch >= 48 && ch <= 57) || ch === 45 || ch === 95)
        nameEnd++
      else
        break
    }
    const afterName = html.charCodeAt(nameEnd)
    if (nameEnd < len && afterName !== 62 && afterName !== 47 && afterName !== 32 && afterName !== 9 && afterName !== 10 && afterName !== 13) {
      i = nameEnd
      continue
    }
    let j = nameEnd
    let quote = 0
    while (j < len) {
      const ch = html.charCodeAt(j)
      if (quote !== 0) {
        if (ch === quote)
          quote = 0
      }
      else if (ch === 34 || ch === 39) {
        quote = ch
      }
      else if (ch === 62) {
        break
      }
      j++
    }
    if (j >= len)
      break
    const selfClose = html.charCodeAt(j - 1) === 47 ? '/' : ''
    const attrEnd = selfClose ? j - 1 : j
    tags.push({
      start: lt,
      end: j + 1,
      tag: html.slice(lt + 1, nameEnd),
      rawAttrs: html.slice(nameEnd, attrEnd),
      selfClose,
    })
    i = j + 1
  }
  return tags
}

function wireFieldHtml(html: string, wiring: FieldControlWiring): string {
  const tags = scanOpeningTags(html)
  const nativeMatch = tags.find((t) => {
    const lower = t.tag.toLowerCase()
    if (lower === 'input' && /\btype\s*=\s*(?:"hidden"|'hidden'|hidden\b)/i.test(t.rawAttrs))
      return false
    return lower === 'input' || lower === 'textarea' || lower === 'select'
  })
  const target = nativeMatch ?? tags.find(t => /\brole\s*=\s*["'](?:combobox|textbox|listbox|spinbutton)["']/i.test(t.rawAttrs))
  if (target === undefined)
    return html

  const lowerTag = target.tag.toLowerCase()
  let attrs = target.rawAttrs
  if (!/\bid\s*=/i.test(attrs))
    attrs += ` id="${escAttr(wiring.id)}"`

  if (wiring.describedBy) {
    const descRe = /(\baria-describedby\s*=\s*")([^"]*)(")/i
    if (descRe.test(attrs))
      attrs = attrs.replace(descRe, (_, p1: string, cur: string, p3: string) => `${p1}${escAttr(mergeTokenAttr(cur, wiring.describedBy!))}${p3}`)
    else
      attrs += ` aria-describedby="${escAttr(wiring.describedBy)}"`
  }

  if (wiring.invalid && !/\baria-invalid\s*=/i.test(attrs))
    attrs += ' aria-invalid="true"'

  if (wiring.required) {
    if ((lowerTag === 'input' || lowerTag === 'textarea' || lowerTag === 'select') && !/\brequired(?:\s|=|$)/i.test(attrs))
      attrs += ' required'
    if (!/\baria-required\s*=/i.test(attrs))
      attrs += ' aria-required="true"'
  }

  return `${html.slice(0, target.start)}<${target.tag}${attrs}${target.selfClose}>${html.slice(target.end)}`
}

function wireFieldElement(el: Element, wiring: FieldControlWiring): void {
  if (!el.hasAttribute('id'))
    el.setAttribute('id', wiring.id)
  if (wiring.describedBy)
    el.setAttribute('aria-describedby', mergeTokenAttr(el.getAttribute('aria-describedby'), wiring.describedBy))
  if (wiring.invalid && !el.hasAttribute('aria-invalid'))
    el.setAttribute('aria-invalid', 'true')
  if (wiring.required) {
    const tag = el.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT')
      el.setAttribute('required', '')
    if (!el.hasAttribute('aria-required'))
      el.setAttribute('aria-required', 'true')
  }
}

function findFieldControlInNode(node: Node): Element | null {
  if (node.nodeType === 1) {
    const el = node as Element
    const tag = el.tagName
    if ((tag === 'INPUT' && el.getAttribute('type')?.toLowerCase() !== 'hidden') || tag === 'TEXTAREA' || tag === 'SELECT')
      return el
    const found = el.querySelector('input:not([type="hidden"]), textarea, select, [role="combobox"], [role="textbox"]')
    if (found !== null)
      return found
  }
  else if (node.nodeType === 11) {
    const frag = node as DocumentFragment
    return frag.querySelector('input:not([type="hidden"]), textarea, select, [role="combobox"], [role="textbox"]')
  }
  return null
}

const RAW_HTML_BRAND = Symbol.for('kay.html')

function wireFieldChildren(children: KayChild, wiring: FieldControlWiring, state: { done: boolean } = { done: false }): KayChild {
  if (state.done || children == null || typeof children === 'boolean' || typeof children === 'string' || typeof children === 'number')
    return children
  if (Array.isArray(children)) {
    return children.map(child => (state.done ? child : wireFieldChildren(child, wiring, state)))
  }
  if (typeof children === 'object' && '__html' in children && (children as unknown as Record<symbol, unknown>)[RAW_HTML_BRAND] === true) {
    const src = (children as Html).__html
    const patched = wireFieldHtml(src, wiring)
    if (patched !== src) {
      state.done = true
      return { [RAW_HTML_BRAND]: true, __html: patched } as unknown as Html
    }
    return children
  }
  if (typeof Node !== 'undefined' && children instanceof Node) {
    const ctrl = findFieldControlInNode(children)
    if (ctrl !== null) {
      wireFieldElement(ctrl, wiring)
      state.done = true
    }
    return children
  }
  return children
}

export function Field(props: FieldProps) {
  const isBrowser = typeof document !== 'undefined'
  const buildWiring = (): FieldControlWiring => {
    const err = isBrowser ? undefined : props.error
    const describedBy = err ? `${props.id}-error` : props.hint ? `${props.id}-hint` : undefined
    return {
      id: props.id,
      describedBy,
      invalid: Boolean(err),
      required: Boolean(props.required),
    }
  }

  return (
    <div data-ui="field" data-invalid={props.error ? 'true' : undefined} class={props.class}>
      <label data-part="label" for={props.id}>
        {props.label}
        {props.required && <span aria-hidden="true"> *</span>}
      </label>
      {(() => {
        const wiring = buildWiring()
        return provideContext(FieldContext, wiring, () => wireFieldChildren(props.children, wiring))
      })()}
      {props.hint && !props.error && <p data-part="hint" id={`${props.id}-hint`}>{props.hint}</p>}
      {props.error && <p data-part="error" id={`${props.id}-error`} role="alert">{props.error}</p>}
    </div>
  )
}

/** Zero-JS native Popover API trigger + anchored popover panel (`0 KB` client JS!). */
export interface PopoverProps {
  id: string
  triggerLabel: string
  triggerVariant?: ButtonVariant | undefined
  children?: KayChild | undefined
}

export function Popover({ id, triggerLabel, triggerVariant = 'outline', children }: PopoverProps) {
  return (
    <>
      <button
        data-ui="button"
        data-variant={triggerVariant}
        type="button"
        popovertarget={id}
      >
        {triggerLabel}
      </button>
      <div
        id={id}
        data-ui="popover"
        popover="auto"
      >
        {children}
      </div>
    </>
  )
}

// ---- Zero-JS native form controls (`0 KB` client JS!) ----

export interface CheckControlProps {
  id?: string | undefined
  name?: string | undefined
  value?: string | undefined
  label: string
  checked?: boolean | undefined
  disabled?: boolean | undefined
  class?: string | undefined
  [attr: string]: unknown
}

export function Checkbox({ id, name, value, label, checked, disabled, class: cls, ...rest }: CheckControlProps) {
  return (
    <label data-ui="checkbox" data-disabled={disabled ? 'true' : undefined} class={cls}>
      <input id={id} type="checkbox" name={name} value={value} checked={checked} disabled={disabled} {...rest} />
      <span data-part="label">{label}</span>
    </label>
  )
}

export function Switch({ id, name, value, label, checked, disabled, class: cls, ...rest }: CheckControlProps) {
  return (
    <label data-ui="switch" data-disabled={disabled ? 'true' : undefined} class={cls}>
      <input id={id} type="checkbox" role="switch" name={name} value={value} checked={checked} disabled={disabled} {...rest} />
      <span data-part="track" aria-hidden="true" />
      <span data-part="label">{label}</span>
    </label>
  )
}

export interface RadioOption {
  value: string
  label: string
  hint?: string | undefined
  disabled?: boolean | undefined
}

export interface RadioGroupProps {
  name: string
  legend?: string | undefined
  options: RadioOption[]
  defaultValue?: string | undefined
  class?: string | undefined
}

export function RadioGroup({ name, legend, options, defaultValue, class: cls }: RadioGroupProps) {
  return (
    <fieldset data-ui="radio-group" class={cls}>
      {legend && <legend data-part="legend">{legend}</legend>}
      <div data-part="options">
        {options.map(opt => (
          <label key={opt.value} data-part="option" data-disabled={opt.disabled ? 'true' : undefined}>
            <input
              type="radio"
              name={name}
              value={opt.value}
              checked={defaultValue === opt.value ? true : undefined}
              disabled={opt.disabled}
            />
            <span data-part="label">{opt.label}</span>
            {opt.hint && <span data-part="hint">{opt.hint}</span>}
          </label>
        ))}
      </div>
    </fieldset>
  )
}

// ---- Every Layout primitives (pure CSS, 0 KB JS, strict-CSP safe) ----

export type SpaceToken = 'none' | '2xs' | 'xs' | 'sm' | 'md' | 'lg' | 'xl' | '2xl'
export type TrackSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl'
export type SpaceValue = SpaceToken | (string & {})
export type TrackValue = TrackSize | (string & {})

const SPACE_TOKENS = new Set<string>(['none', '2xs', 'xs', 'sm', 'md', 'lg', 'xl', '2xl'])
const TRACK_TOKENS = new Set<string>(['xs', 'sm', 'md', 'lg', 'xl'])

const isSpaceToken = (v: string | undefined): boolean => v !== undefined && SPACE_TOKENS.has(v)
const isTrackToken = (v: string | undefined): boolean => v !== undefined && TRACK_TOKENS.has(v)

export function Stack(props: BoxProps & { gap?: SpaceValue | undefined }) {
  const rest = restProps(props, ['gap', 'class'])
  return (
    <div
      data-layout="stack"
      data-gap={isSpaceToken(props.gap) ? props.gap : undefined}
      data-gap-value={props.gap && !isSpaceToken(props.gap) ? props.gap : undefined}
      class={props.class}
      {...rest}
    >
      {props.children}
    </div>
  )
}

export function Cluster(props: BoxProps & { gap?: SpaceValue | undefined }) {
  const rest = restProps(props, ['gap', 'class'])
  return (
    <div
      data-layout="cluster"
      data-gap={isSpaceToken(props.gap) ? props.gap : undefined}
      data-gap-value={props.gap && !isSpaceToken(props.gap) ? props.gap : undefined}
      class={props.class}
      {...rest}
    >
      {props.children}
    </div>
  )
}

export function Grid(props: BoxProps & { min?: TrackValue | undefined, gap?: SpaceValue | undefined }) {
  const rest = restProps(props, ['min', 'gap', 'class'])
  return (
    <div
      data-layout="grid"
      data-min={isTrackToken(props.min) ? props.min : undefined}
      data-min-value={props.min && !isTrackToken(props.min) ? props.min : undefined}
      data-gap={isSpaceToken(props.gap) ? props.gap : undefined}
      data-gap-value={props.gap && !isSpaceToken(props.gap) ? props.gap : undefined}
      class={props.class}
      {...rest}
    >
      {props.children}
    </div>
  )
}

export function Sidebar(props: BoxProps & { side?: TrackValue | undefined, gap?: SpaceValue | undefined }) {
  const rest = restProps(props, ['side', 'gap', 'class'])
  return (
    <div
      data-layout="sidebar"
      data-side={isTrackToken(props.side) ? props.side : undefined}
      data-side-value={props.side && !isTrackToken(props.side) ? props.side : undefined}
      data-gap={isSpaceToken(props.gap) ? props.gap : undefined}
      data-gap-value={props.gap && !isSpaceToken(props.gap) ? props.gap : undefined}
      class={props.class}
      {...rest}
    >
      {props.children}
    </div>
  )
}

export function Split(props: BoxProps & { gap?: SpaceValue | undefined }) {
  const rest = restProps(props, ['gap', 'class'])
  return (
    <div
      data-layout="split"
      data-gap={isSpaceToken(props.gap) ? props.gap : undefined}
      data-gap-value={props.gap && !isSpaceToken(props.gap) ? props.gap : undefined}
      class={props.class}
      {...rest}
    >
      {props.children}
    </div>
  )
}
