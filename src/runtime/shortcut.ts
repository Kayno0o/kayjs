import { effect, onCleanup, onMount } from './reactive'

export interface ShortcutOptions {
  // The element the shortcut works inside, or a function returning it once the island mounted, as `() => form` for a `ref`'s variable; the whole page when the option is left out, and nothing when it is there but holds no element. An element-scoped shortcut also sets `aria-keyshortcuts` on it.
  on?: Element | (() => Element | null | undefined) | undefined
  // Fires while a text field, a select or a `contenteditable` element has the focus, which a shortcut with Ctrl, Cmd or Alt does anyway; a bare key such as `/` does not unless this is true.
  inputs?: boolean | undefined
  // Fires again while the key is held down; once per press by default.
  repeat?: boolean | undefined
  // Cancels the browser's own action for the key, as `mod+s` saving the page; true by default.
  preventDefault?: boolean | undefined
}

interface Parsed {
  key: string
  ctrl: boolean
  meta: boolean
  alt: boolean
  shift: boolean
  // A symbol such as `?` or `/` is typed with Shift on some layouts, so Shift does not tell the binding apart.
  symbol: boolean
}

const ALIASES: Record<string, string> = { esc: 'escape', space: ' ', plus: '+', up: 'arrowup', down: 'arrowdown', left: 'arrowleft', right: 'arrowright', return: 'enter' }
const NAMES: Record<string, string> = { ' ': 'Space', 'escape': 'Escape', 'arrowup': 'ArrowUp', 'arrowdown': 'ArrowDown', 'arrowleft': 'ArrowLeft', 'arrowright': 'ArrowRight', 'enter': 'Enter', 'tab': 'Tab', 'backspace': 'Backspace', 'delete': 'Delete' }

// Escape and the function keys type nothing, so a field has no use for them.
const PASSES = /^(?:escape|f\d{1,2})$/

function isApple(): boolean {
  const platform = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform ?? ''

  return (/mac|iphone|ipad|ipod/i).test(platform)
}

function parse(spec: string, apple: boolean): Parsed {
  const plus = spec.endsWith('+')
  const parts = (plus ? spec.slice(0, -1) : spec).split('+')
  const named = plus ? '+' : parts.pop() ?? ''
  const raw = plus ? parts.filter(Boolean) : parts
  const parsed: Parsed = { key: ALIASES[named.toLowerCase()] ?? named.toLowerCase(), ctrl: false, meta: false, alt: false, shift: false, symbol: false }

  if (named === '')
    throw new Error(`shortcut('${spec}') names no key`)

  for (const modifier of raw.map(part => part.toLowerCase())) {
    if (modifier === 'mod')
      parsed[apple ? 'meta' : 'ctrl'] = true
    else if (modifier === 'ctrl' || modifier === 'meta' || modifier === 'alt' || modifier === 'shift')
      parsed[modifier] = true
    else
      throw new Error(`shortcut('${spec}') has an unknown modifier '${modifier}': use mod, ctrl, meta, alt or shift`)
  }

  parsed.symbol = parsed.key.length === 1 && !(/[a-z0-9]/).test(parsed.key)

  return parsed
}

// The key pressed, by what it types when that is a letter or a digit of the Latin alphabet, else by the physical key: Ctrl+S on a Cyrillic layout, or Option+S on a Mac, types another character, and the digit row of an AZERTY layout types symbols.
function pressed(event: KeyboardEvent, key: string): boolean {
  const typed = event.key.toLowerCase()

  if (typed === key)
    return true

  if ((/^[a-z]$/).test(key))
    return !(/^[\u0020-\u007E]$/).test(typed) && event.code === `Key${key.toUpperCase()}`

  return (/^\d$/).test(key) && !(/^[a-z0-9]$/).test(typed) && event.code === `Digit${key}`
}

function editable(event: KeyboardEvent, key: string): boolean {
  const target = event.composedPath?.()[0] ?? event.target

  if (!(target instanceof Element))
    return false

  if ((key === 'enter' || key === ' ') && target.closest('button, a[href], summary'))
    return true

  return target.matches('input, textarea, select') || (target as HTMLElement).isContentEditable === true || target.closest('[contenteditable]:not([contenteditable="false"])') !== null
}

function label(parsed: Parsed): string {
  const key = parsed.key.length === 1 ? parsed.key.toUpperCase() : NAMES[parsed.key] ?? parsed.key

  return [parsed.ctrl && 'Control', parsed.meta && 'Meta', parsed.alt && 'Alt', parsed.shift && 'Shift', key].filter(Boolean).join('+')
}

// Runs `handler` when `keys` is pressed, `keys` following the signals a function reads (`null` binds nothing), for as long as the island lives: `mod+s` is Cmd+S on macOS and iOS and Ctrl+S elsewhere, `ctrl`, `meta`, `alt` and `shift` name a modifier, and a key is a character, `escape`, `enter`, `arrowup` or `space`.
// Nothing happens on the server, while composing text with an IME, or when something handled the event first, so the innermost of two bindings on one key wins when it prevents the default.
export function shortcut(keys: string | (() => string | null | undefined), handler: (event: KeyboardEvent) => void, options: ShortcutOptions = {}): void {
  if (typeof document === 'undefined')
    return

  const apple = isApple()

  if (typeof keys === 'string')
    parse(keys, apple)

  onMount(() => {
    const scope = typeof options.on === 'function' ? options.on() : options.on

    // An `on` still undefined or null when the island mounted binds nothing, rather than the whole page.
    if ('on' in options && !scope)
      return

    effect(() => {
      const spec = typeof keys === 'function' ? keys() : keys

      if (spec !== undefined && spec !== null && spec !== '')
        bind(parse(spec, apple), scope ?? window, scope ?? undefined, handler, options)
    })
  })
}

// Listens for the shortcut on `target` until the computation it runs in is cleaned up.
function bind(parsed: Parsed, target: EventTarget, scope: Element | undefined, handler: (event: KeyboardEvent) => void, options: ShortcutOptions): void {
  const listener = (event: Event): void => {
    const press = event as KeyboardEvent

    if (press.defaultPrevented || press.isComposing || press.keyCode === 229 || (press.repeat && !options.repeat))
      return

    if (press.ctrlKey !== parsed.ctrl || press.metaKey !== parsed.meta || press.altKey !== parsed.alt || (!parsed.symbol && press.shiftKey !== parsed.shift) || !pressed(press, parsed.key))
      return

    if (options.inputs !== true && !parsed.ctrl && !parsed.meta && !parsed.alt && !PASSES.test(parsed.key) && editable(press, parsed.key))
      return

    if (options.preventDefault !== false)
      press.preventDefault()

    handler(press)
  }

  target.addEventListener('keydown', listener)
  onCleanup(() => target.removeEventListener('keydown', listener))

  if (!scope)
    return

  const token = label(parsed)
  const current = scope.getAttribute('aria-keyshortcuts')?.split(' ').filter(Boolean) ?? []

  scope.setAttribute('aria-keyshortcuts', [...current, token].join(' '))
  onCleanup(() => {
    const rest = scope.getAttribute('aria-keyshortcuts')?.split(' ').filter(Boolean) ?? []
    const index = rest.indexOf(token)

    if (index >= 0)
      rest.splice(index, 1)

    if (rest.length > 0)
      scope.setAttribute('aria-keyshortcuts', rest.join(' '))
    else
      scope.removeAttribute('aria-keyshortcuts')
  })
}
