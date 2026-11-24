/** @jsxImportSource kay */
// Zero-JS static & native-platform primitives (`0 KB` client JS!).
// Emit only semantic `data-ui`, `data-part`, `data-variant`, `data-tone`, `data-layout` attributes.

import type { Html, KayChild } from 'kay'

export type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger'
export type ButtonVariant = 'solid' | 'outline' | 'ghost'
export type Size = 'sm' | 'md' | 'lg'

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

export function Button({ variant = 'solid', tone, size = 'md', href, type = 'button', children, ...rest }: ButtonProps) {
  if (href !== undefined) {
    return (
      <a data-ui="button" data-variant={variant} data-tone={tone} data-size={size} href={href} {...rest}>
        {children}
      </a>
    )
  }
  return (
    <button data-ui="button" data-variant={variant} data-tone={tone} data-size={size} type={type} {...rest}>
      {children}
    </button>
  )
}

export function Badge({ tone, class: cls, children, ...rest }: { tone?: Tone | undefined, class?: string | undefined, children?: KayChild | undefined, [attr: string]: unknown }) {
  return <span data-ui="badge" data-tone={tone} class={cls} {...rest}>{children}</span>
}

export function Notice({ tone, role = 'status', class: cls, children, ...rest }: { tone?: Tone | undefined, role?: 'status' | 'alert' | 'note' | undefined, class?: string | undefined, children?: KayChild | undefined, [attr: string]: unknown }) {
  return <div data-ui="notice" data-tone={tone} role={role} class={cls} {...rest}>{children}</div>
}

export function Card({ class: cls, children, ...rest }: { class?: string | undefined, children?: KayChild | undefined, [attr: string]: unknown }) {
  return <section data-ui="card" class={cls} {...rest}>{children}</section>
}

export function CardHeader({ class: cls, children, ...rest }: { class?: string | undefined, children?: KayChild | undefined, [attr: string]: unknown }) {
  return <header data-part="header" class={cls} {...rest}>{children}</header>
}

export function CardBody({ class: cls, children, ...rest }: { class?: string | undefined, children?: KayChild | undefined, [attr: string]: unknown }) {
  return <div data-part="body" class={cls} {...rest}>{children}</div>
}

export function CardFooter({ class: cls, children, ...rest }: { class?: string | undefined, children?: KayChild | undefined, [attr: string]: unknown }) {
  return <footer data-part="footer" class={cls} {...rest}>{children}</footer>
}

/** Zero-JS native `<details>` accordion (`name` enables exclusive mode natively in the browser). */
export function Accordion({ class: cls, children, ...rest }: { class?: string | undefined, children?: KayChild | undefined, [attr: string]: unknown }) {
  return <div data-ui="accordion" class={cls} {...rest}>{children}</div>
}

export function AccordionItem({ title, group, open, children, ...rest }: { title: string, group?: string | undefined, open?: boolean | undefined, children?: KayChild | undefined, [attr: string]: unknown }) {
  return (
    <details name={group} open={open} {...rest}>
      <summary data-part="trigger">{title}</summary>
      <div data-part="content">{children}</div>
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

interface FieldControlWiring {
  id: string
  describedBy: string | undefined
  invalid: boolean
  required: boolean
}

function escapeAttrValue(str: string): string {
  return str
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

function mergeTokenAttr(existing: string | null | undefined, addition: string): string {
  const tokens = (existing ?? '').split(/\s+/).filter(Boolean)
  for (const tok of addition.split(/\s+/).filter(Boolean)) {
    if (!tokens.includes(tok))
      tokens.push(tok)
  }
  return tokens.join(' ')
}

function wireFieldHtml(html: string, wiring: FieldControlWiring): string {
  let matched = false
  const patchTag = (full: string, tag: string, rawAttrs: string, selfClose: string): string => {
    const lowerTag = tag.toLowerCase()
    if (lowerTag === 'input' && /\btype\s*=\s*(?:"hidden"|'hidden'|hidden\b)/i.test(rawAttrs))
      return full
    if (matched)
      return full
    matched = true

    let attrs = rawAttrs
    if (!/\bid\s*=/i.test(attrs))
      attrs += ` id="${escapeAttrValue(wiring.id)}"`

    if (wiring.describedBy) {
      const descRe = /(\baria-describedby\s*=\s*")([^"]*)(")/i
      if (descRe.test(attrs))
        attrs = attrs.replace(descRe, (_, p1: string, cur: string, p3: string) => `${p1}${escapeAttrValue(mergeTokenAttr(cur, wiring.describedBy!))}${p3}`)
      else
        attrs += ` aria-describedby="${escapeAttrValue(wiring.describedBy)}"`
    }

    if (wiring.invalid && !/\baria-invalid\s*=/i.test(attrs))
      attrs += ' aria-invalid="true"'

    if (wiring.required) {
      if ((lowerTag === 'input' || lowerTag === 'textarea' || lowerTag === 'select') && !/\brequired(?:\s|=|$)/i.test(attrs))
        attrs += ' required'
      if (!/\baria-required\s*=/i.test(attrs))
        attrs += ' aria-required="true"'
    }

    return `<${tag}${attrs}${selfClose}>`
  }

  const nativePatched = html.replace(/<(input|textarea|select)\b([^>]*?)(\/?)>/gi, patchTag)
  if (matched)
    return nativePatched

  // Fallback for custom controls (e.g. role="combobox" / role="textbox")
  return html.replace(/<([a-z][\w-]*)\b([^>]*\brole\s*=\s*["'](?:combobox|textbox|listbox|spinbutton)["'][^>]*?)(\/?)>/i, patchTag)
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

function wireFieldChildren(children: KayChild, wiring: FieldControlWiring): KayChild {
  if (children == null || typeof children === 'boolean' || typeof children === 'string' || typeof children === 'number')
    return children
  if (Array.isArray(children)) {
    let done = false
    return children.map((child) => {
      if (done)
        return child
      const next = wireFieldChildren(child, wiring)
      if (next !== child)
        done = true
      return next
    })
  }
  if (typeof children === 'object' && '__html' in children && (children as unknown as Record<symbol, unknown>)[RAW_HTML_BRAND] === true) {
    const src = (children as Html).__html
    const patched = wireFieldHtml(src, wiring)
    return patched === src ? children : ({ [RAW_HTML_BRAND]: true, __html: patched } as unknown as Html)
  }
  if (typeof Node !== 'undefined' && children instanceof Node) {
    const ctrl = findFieldControlInNode(children)
    if (ctrl !== null)
      wireFieldElement(ctrl, wiring)
    return children
  }
  return children
}

export function Field({ id, label, hint, error, required, class: cls, children }: FieldProps) {
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined
  const wiredChildren = wireFieldChildren(children, {
    id,
    describedBy,
    invalid: Boolean(error),
    required: Boolean(required),
  })

  return (
    <div data-ui="field" data-invalid={error ? 'true' : undefined} class={cls}>
      <label data-part="label" for={id}>
        {label}
        {required && <span aria-hidden="true"> *</span>}
      </label>
      {wiredChildren}
      {hint && !error && <p data-part="hint" id={`${id}-hint`}>{hint}</p>}
      {error && <p data-part="error" id={`${id}-error`} role="alert">{error}</p>}
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
  const anchor = `--kui-anchor-${id}`
  return (
    <>
      <button
        data-ui="button"
        data-variant={triggerVariant}
        type="button"
        popovertarget={id}
        style={`anchor-name: ${anchor}`}
      >
        {triggerLabel}
      </button>
      <div
        id={id}
        data-ui="popover"
        popover="auto"
        style={`position-anchor: ${anchor}`}
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

// ---- Every Layout primitives (pure CSS, 0 KB JS) ----

export function Stack({ gap, class: cls, children, ...rest }: { gap?: string | undefined, class?: string | undefined, children?: KayChild | undefined, [attr: string]: unknown }) {
  return <div data-layout="stack" style={gap ? `--ui-gap:${gap}` : undefined} class={cls} {...rest}>{children}</div>
}

export function Cluster({ gap, class: cls, children, ...rest }: { gap?: string | undefined, class?: string | undefined, children?: KayChild | undefined, [attr: string]: unknown }) {
  return <div data-layout="cluster" style={gap ? `--ui-gap:${gap}` : undefined} class={cls} {...rest}>{children}</div>
}

export function Grid({ min, gap, class: cls, children, ...rest }: { min?: string | undefined, gap?: string | undefined, class?: string | undefined, children?: KayChild | undefined, [attr: string]: unknown }) {
  const style = [min ? `--ui-min:${min}` : '', gap ? `--ui-gap:${gap}` : ''].filter(Boolean).join(';') || undefined
  return <div data-layout="grid" style={style} class={cls} {...rest}>{children}</div>
}

export function Sidebar({ side, gap, class: cls, children, ...rest }: { side?: string | undefined, gap?: string | undefined, class?: string | undefined, children?: KayChild | undefined, [attr: string]: unknown }) {
  const style = [side ? `--ui-side:${side}` : '', gap ? `--ui-gap:${gap}` : ''].filter(Boolean).join(';') || undefined
  return <div data-layout="sidebar" style={style} class={cls} {...rest}>{children}</div>
}

export function Split({ gap, class: cls, children, ...rest }: { gap?: string | undefined, class?: string | undefined, children?: KayChild | undefined, [attr: string]: unknown }) {
  return <div data-layout="split" style={gap ? `--ui-gap:${gap}` : undefined} class={cls} {...rest}>{children}</div>
}
