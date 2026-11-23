// TypeScript JSX runtime types for Kay v2.
// Standard TSX compiles away at build time; these types power full IDE autocomplete & type checking.

export type HydrateStrategy =
  | 'load'
  | 'visible'
  | 'idle'
  | 'interaction'
  | 'client'
  | `media(${string})`

export type KayChild =
  | string
  | number
  | boolean
  | null
  | undefined
  | Html
  | Node
  | KayChild[]

export interface Html {
  readonly __html: string
}

export type Component<P = Record<string, unknown>> = (props: P) => KayChild | Promise<KayChild>

export function Fragment(props: { children?: KayChild }): KayChild {
  return props.children
}

// Runtime fallbacks (only used if JSX isn't compiled, e.g. quick tests)
export function jsx(tag: unknown, props: Record<string, unknown>): KayChild | Promise<KayChild> {
  if (typeof tag === 'function')
    return (tag as Component)(props)
  return null
}

export const jsxs = jsx
export const jsxDEV = jsx

interface CommonAttributes {
  id?: string | undefined
  class?: string | undefined
  className?: string | undefined
  style?: string | Record<string, string | number | undefined> | undefined
  title?: string | undefined
  tabIndex?: number | undefined
  hidden?: boolean | undefined
  role?: string | undefined
  lang?: string | undefined
  dir?: string | undefined
  draggable?: boolean | undefined
  contentEditable?: boolean | 'true' | 'false' | 'plaintext-only' | undefined
  slot?: string | undefined
  children?: KayChild | undefined
  key?: string | number | undefined
  ref?: ((el: Element) => void) | undefined
  $hydrate?: HydrateStrategy | undefined
  // Events
  onClick?: ((e: MouseEvent) => void) | undefined
  onDblClick?: ((e: MouseEvent) => void) | undefined
  onInput?: ((e: Event) => void) | undefined
  onChange?: ((e: Event) => void) | undefined
  onSubmit?: ((e: SubmitEvent) => void) | undefined
  onKeyDown?: ((e: KeyboardEvent) => void) | undefined
  onKeyUp?: ((e: KeyboardEvent) => void) | undefined
  onFocus?: ((e: FocusEvent) => void) | undefined
  onBlur?: ((e: FocusEvent) => void) | undefined
  onMouseEnter?: ((e: MouseEvent) => void) | undefined
  onMouseLeave?: ((e: MouseEvent) => void) | undefined
  onPointerDown?: ((e: PointerEvent) => void) | undefined
  onPointerUp?: ((e: PointerEvent) => void) | undefined
  [attr: `data-${string}`]: string | number | boolean | undefined
  [attr: `aria-${string}`]: string | number | boolean | undefined
  [attr: string]: unknown
}

interface AnchorAttributes extends CommonAttributes {
  href?: string | undefined
  target?: string | undefined
  rel?: string | undefined
  download?: string | boolean | undefined
}

interface ButtonAttributes extends CommonAttributes {
  type?: 'button' | 'submit' | 'reset' | undefined
  disabled?: boolean | undefined
  name?: string | undefined
  value?: string | undefined
}

interface InputAttributes extends CommonAttributes {
  type?: string | undefined
  name?: string | undefined
  value?: string | number | undefined
  checked?: boolean | undefined
  disabled?: boolean | undefined
  placeholder?: string | undefined
  required?: boolean | undefined
  min?: string | number | undefined
  max?: string | number | undefined
  step?: string | number | undefined
  readOnly?: boolean | undefined
  autoComplete?: string | undefined
  autoFocus?: boolean | undefined
}

interface FormAttributes extends CommonAttributes {
  action?: string | ((...args: never[]) => unknown) | undefined
  method?: 'get' | 'post' | 'GET' | 'POST' | undefined
  encType?: string | undefined
  noValidate?: boolean | undefined
}

interface ImageAttributes extends CommonAttributes {
  src?: string | undefined
  alt?: string | undefined
  width?: string | number | undefined
  height?: string | number | undefined
  loading?: 'lazy' | 'eager' | undefined
  decoding?: 'async' | 'sync' | 'auto' | undefined
}

interface LabelAttributes extends CommonAttributes {
  for?: string | undefined
  htmlFor?: string | undefined
}

interface LinkAttributes extends CommonAttributes {
  rel?: string | undefined
  href?: string | undefined
  as?: string | undefined
  type?: string | undefined
  crossOrigin?: string | undefined
}

interface MetaAttributes extends CommonAttributes {
  name?: string | undefined
  property?: string | undefined
  content?: string | undefined
  charSet?: string | undefined
  charset?: string | undefined
}

interface ScriptAttributes extends CommonAttributes {
  src?: string | undefined
  type?: string | undefined
  async?: boolean | undefined
  defer?: boolean | undefined
  nonce?: string | undefined
}

export namespace JSX {
  export type Element = KayChild
  export interface IntrinsicAttributes {
    key?: string | number | undefined
    $hydrate?: HydrateStrategy | undefined
  }
  export interface ElementChildrenAttribute {
    children: object
  }
  export interface IntrinsicElements {
    a: AnchorAttributes
    button: ButtonAttributes
    input: InputAttributes
    form: FormAttributes
    img: ImageAttributes
    label: LabelAttributes
    link: LinkAttributes
    meta: MetaAttributes
    script: ScriptAttributes
    [tag: string]: CommonAttributes
  }
}
