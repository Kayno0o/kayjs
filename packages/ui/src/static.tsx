/** @jsxImportSource @kayjs/kay */
// Zero-JS static & native-platform primitives (`0 KB` client JS!).
// Emit only semantic `data-ui`, `data-part`, `data-variant`, `data-tone`, `data-layout` attributes.

import type { Context, Html, KayChild } from '@kayjs/kay'
import type { FieldControlWiring } from './field-context'
import { provideContext } from '@kayjs/kay'
import { FIELD_CONTEXT_ID } from './field-context'

export type { FieldControlWiring } from './field-context'
export { useFieldContext } from './field-context'

export const FieldContext: Context<FieldControlWiring | undefined> = {
  id: FIELD_CONTEXT_ID,
  defaultValue: undefined,
  Provider(props) {
    return provideContext(FieldContext, props.value, () => {
      const c = props.children
      return typeof c === 'function' ? (c as () => KayChild)() : c
    })
  },
}

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

export function Notice(props: BoxProps & { tone?: Tone | undefined, role?: 'status' | 'alert' | 'note' | undefined }) {
  const rest = restProps(props, ['tone', 'role', 'class'])
  return <div data-ui="notice" data-tone={props.tone} role={props.role ?? 'status'} class={props.class} {...rest}>{props.children}</div>
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

const OPEN_TAG_RE = /<([a-zA-Z][\w-]*)(?=[\s/>])((?:"[^"]*"|'[^']*'|[^>"'])*)>/g

/** Quote-aware HTML opening tag scanner so `>` inside attribute values (e.g. `placeholder="x > 0"`) never truncates a tag. */
function scanOpeningTags(html: string): ScannedTag[] {
  const tags: ScannedTag[] = []
  OPEN_TAG_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = OPEN_TAG_RE.exec(html)) !== null) {
    const body = m[2]!
    const selfClose = body.endsWith('/') ? '/' : ''
    tags.push({
      start: m.index,
      end: m.index + m[0].length,
      tag: m[1]!,
      rawAttrs: selfClose ? body.slice(0, -1) : body,
      selfClose,
    })
  }
  return tags
}

const NATIVE_CTRL_RE = /^(?:input|textarea|select)$/i

function wireFieldHtml(html: string, wiring: FieldControlWiring): string {
  const tags = scanOpeningTags(html)
  const target = tags.find(t => NATIVE_CTRL_RE.test(t.tag) && !(/\btype\s*=\s*(?:"hidden"|'hidden'|hidden\b)/i.test(t.rawAttrs) && /^input$/i.test(t.tag)))
    ?? tags.find(t => /\brole\s*=\s*["'](?:combobox|textbox|listbox|spinbutton)["']/i.test(t.rawAttrs))
  if (target === undefined)
    return html

  let attrs = target.rawAttrs
  if (!/\bid\s*=/i.test(attrs))
    attrs += ` id="${escAttr(wiring.id)}"`
  else if (/\bid\s*=\s*"kui-[^"]*"/i.test(attrs))
    attrs = attrs.replace(/\bid\s*=\s*"kui-[^"]*"/i, `id="${escAttr(wiring.id)}"`)

  if (wiring.describedBy) {
    const descRe = /(\baria-describedby\s*=\s*")([^"]*)(")/i
    attrs = descRe.test(attrs)
      ? attrs.replace(descRe, (_, p1: string, cur: string, p3: string) => `${p1}${escAttr(mergeTokenAttr(cur, wiring.describedBy!))}${p3}`)
      : `${attrs} aria-describedby="${escAttr(wiring.describedBy)}"`
  }
  if (wiring.invalid && !/\baria-invalid\s*=/i.test(attrs))
    attrs += ' aria-invalid="true"'
  if (wiring.required) {
    if (NATIVE_CTRL_RE.test(target.tag) && !/\brequired(?:\s|=|$)/i.test(attrs))
      attrs += ' required'
    if (!/\baria-required\s*=/i.test(attrs))
      attrs += ' aria-required="true"'
  }
  return `${html.slice(0, target.start)}<${target.tag}${attrs}${target.selfClose}>${html.slice(target.end)}`
}

const CTRL_SEL = 'input:not([type="hidden"]),textarea,select,[role="combobox"],[role="textbox"],[role="listbox"],[role="spinbutton"]'

function syncFieldAria(el: Element, id: string, err: string | undefined, hint: string | undefined, clearInvalid: boolean): void {
  const errId = `${id}-error`
  const hintId = `${id}-hint`
  const tokens = (el.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(t => t && t !== errId && t !== hintId)
  if (err)
    tokens.push(errId)
  else if (hint)
    tokens.push(hintId)
  if (tokens.length > 0)
    el.setAttribute('aria-describedby', tokens.join(' '))
  else
    el.removeAttribute('aria-describedby')
  if (err)
    el.setAttribute('aria-invalid', 'true')
  else if (clearInvalid)
    el.removeAttribute('aria-invalid')
}

function wireFieldElement(el: Element, wiring: FieldControlWiring, err: string | undefined, hint: string | undefined): void {
  const curId = el.getAttribute('id')
  if (!curId || curId.startsWith('kui-'))
    el.setAttribute('id', wiring.id)
  syncFieldAria(el, wiring.id, err, hint, false)
  if (wiring.required) {
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT')
      el.setAttribute('required', '')
    if (!el.hasAttribute('aria-required'))
      el.setAttribute('aria-required', 'true')
  }
}

function findFieldControlInNode(node: Node): Element | null {
  if (node.nodeType === 1) {
    const el = node as Element
    return el.matches(CTRL_SEL) ? el : el.querySelector(CTRL_SEL)
  }
  return node.nodeType === 11 ? (node as DocumentFragment).querySelector(CTRL_SEL) : null
}

const RAW_HTML_BRAND = Symbol.for('kay.html')

function wireFieldChildren(
  children: KayChild,
  wiring: FieldControlWiring,
  err: string | undefined,
  hint: string | undefined,
  onControl: (el: Element) => void,
  state: { done: boolean } = { done: false },
): KayChild {
  if (state.done || children == null || typeof children !== 'object')
    return children
  if (Array.isArray(children))
    return children.map(child => (state.done ? child : wireFieldChildren(child, wiring, err, hint, onControl, state)))
  if ('__html' in children && (children as unknown as Record<symbol, unknown>)[RAW_HTML_BRAND] === true) {
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
      wireFieldElement(ctrl, wiring, err, hint)
      onControl(ctrl)
      state.done = true
    }
  }
  return children
}

export function Field(props: FieldProps) {
  let ctrlEl: Element | null = null
  let lastError: string | undefined
  let ownedInvalid = false

  const syncInvalid = (): 'true' | undefined => {
    const err = props.error
    lastError = err
    if (typeof document !== 'undefined') {
      const target = ctrlEl ?? document.getElementById(props.id)
      if (target !== null && (target === ctrlEl || target.closest('[data-ui="field"]') !== null)) {
        ctrlEl = target
        syncFieldAria(target, props.id, err, props.hint, ownedInvalid)
        ownedInvalid = Boolean(err)
      }
    }
    return err ? 'true' : undefined
  }

  return (
    <div data-ui="field" data-invalid={syncInvalid()} class={props.class}>
      <label data-part="label" for={props.id}>
        {props.label}
        {props.required && <span aria-hidden="true"> *</span>}
      </label>
      {(() => {
        const wiring: FieldControlWiring = {
          id: props.id,
          describedBy: lastError ? `${props.id}-error` : props.hint ? `${props.id}-hint` : undefined,
          invalid: Boolean(lastError),
          required: Boolean(props.required),
        }
        return provideContext(FieldContext, wiring, () => wireFieldChildren(props.children, wiring, lastError, props.hint, (el) => {
          ctrlEl = el
          if (wiring.invalid)
            ownedInvalid = true
        }))
      })()}
      {props.hint && !props.error && <p data-part="hint" id={`${props.id}-hint`}>{props.hint}</p>}
      {props.error && <p data-part="error" id={`${props.id}-error`} role="alert">{props.error}</p>}
    </div>
  )
}

// ---- Every Layout primitives (pure CSS, 0 KB JS, strict-CSP safe) ----

export type SpaceToken = 'none' | '2xs' | 'xs' | 'sm' | 'md' | 'lg' | 'xl' | '2xl'
export type TrackSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl'
export type SpaceValue = SpaceToken | (string & {})
export type TrackValue = TrackSize | (string & {})

const SPACE_TOKENS = new Set<string>(['none', '2xs', 'xs', 'sm', 'md', 'lg', 'xl', '2xl'])

const isSpaceToken = (v: string | undefined): boolean => v !== undefined && SPACE_TOKENS.has(v)

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
