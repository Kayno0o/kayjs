import type { Span } from './ast'
import type { CodeBuilder } from './mapping'

// The event methods a handler may call before it runs, written after its name: `onSubmit|preventDefault`.
const EVENT_METHODS = ['preventDefault', 'stopPropagation']

// The options the listener is added with, named as the DOM names them: `onClick|capture`.
const LISTENER_OPTIONS = new Set(['capture', 'passive'])

// `onKeyDown|enter` runs the handler for that `event.key` only; several keys run it for any of them.
const KEYS = new Map([['enter', 'Enter'], ['escape', 'Escape'], ['space', ' '], ['tab', 'Tab'], ['backspace', 'Backspace'], ['delete', 'Delete'], ['home', 'Home'], ['end', 'End'], ['pageup', 'PageUp'], ['pagedown', 'PageDown'], ['up', 'ArrowUp'], ['down', 'ArrowDown'], ['left', 'ArrowLeft'], ['right', 'ArrowRight']])

const KEY_EVENT = /^onKey(?:Down|Up|Press)$/

// `once` and `self` join them: `once` runs the handler for one event only, `self` only when the event's target is the element.
const EVENT_MODIFIERS: ReadonlySet<string> = new Set([...EVENT_METHODS, ...LISTENER_OPTIONS, 'once', 'self', ...KEYS.keys()])

// The modifiers `event` takes: the key names only for a key event.
export function eventModifiers(event: string): string[] {
  return [...EVENT_METHODS, ...LISTENER_OPTIONS, 'once', 'self', ...KEY_EVENT.test(event) ? KEYS.keys() : []]
}

interface Problem {
  message: string
  help: string
}

// What is wrong with the modifiers written on the handler `name` of an element that spreads props or not: one that is none, one written twice, one that cannot go where it is.
export function modifierProblems(modifiers: string[], name: string, spreads: boolean): Problem[] {
  const problems: Problem[] = []

  for (const [index, modifier] of modifiers.entries()) {
    if (!EVENT_MODIFIERS.has(modifier))
      problems.push({ message: `\`${modifier}\` is no event modifier`, help: `use ${[...EVENT_MODIFIERS].map(known => `\`|${known}\``).join(', ')}` })
    else if (modifiers.indexOf(modifier) !== index)
      problems.push({ message: `\`|${modifier}\` is written twice`, help: 'drop one of them' })
    else if (KEYS.has(modifier) && !KEY_EVENT.test(name))
      problems.push({ message: `\`|${modifier}\` filters a key event, and \`${name}\` is not one`, help: '`input(onKeyDown|enter={send})`' })
    else if (LISTENER_OPTIONS.has(modifier) && spreads)
      problems.push({ message: `\`|${modifier}\` cannot reach the listener of an element that spreads props`, help: 'add the listener in a `ref`, or spread the props on another element' })
    else if (modifier === 'passive' && name.toLowerCase() === 'onsubmit')
      problems.push({ message: '`|passive` cannot go on `onSubmit`, which a form holds while it answers', help: 'use `|capture`, or drop it' })
    else if (modifier === 'passive' && modifiers.includes('preventDefault'))
      problems.push({ message: '`|passive` listeners cannot call `preventDefault`', help: 'drop one of them' })
  }

  return problems
}

// The listener options a handler's modifiers ask for, as the object `listenWith` hands `addEventListener`; none when it asks for none.
export function listenerOptions(modifiers: string[]): string | undefined {
  const options = modifiers.filter(modifier => LISTENER_OPTIONS.has(modifier))

  return options.length > 0 ? `{ ${options.map(option => `${option}: true`).join(', ')} }` : undefined
}

// An event handler read at each event, so one a prop, a signal or a loop item holds stays current; its modifiers run first.
export function addHandler(b: CodeBuilder, expression: Span, modifiers: string[], literal: boolean): void {
  if (modifiers.length > 0)
    addModifiedHandler(b, expression, modifiers)
  else if (literal)
    b.add('(').addSource(expression).add(')')
  else
    b.add('(kayEvent) => (').addSource(expression).add(')?.(kayEvent)')
}

// A handler running its modifiers in the order written, each as the code it stands for: an event method, the checks that return early, and the flag `once` flips.
function addModifiedHandler(b: CodeBuilder, expression: Span, modifiers: string[]): void {
  const steps = modifiers.filter(modifier => !LISTENER_OPTIONS.has(modifier) && modifier !== 'once')
  const once = modifiers.includes('once')
  const keys = steps.flatMap(modifier => KEYS.get(modifier) ?? [])
  const body = once ? ['if (kayDone) return;'] : []
  let keyed = false

  for (const modifier of steps) {
    if (modifier === 'self') {
      body.push('if (kayEvent.target !== kayEvent.currentTarget) return;')
    }
    else if (KEYS.has(modifier)) {
      // The keys are checked together, where the first of them is written.
      if (!keyed)
        body.push(`if (kayEvent.isComposing || !${JSON.stringify(keys)}.includes(kayEvent.key)) return;`)

      keyed = true
    }
    else {
      body.push(`kayEvent.${modifier}();`)
    }
  }

  // Spent once every filter let the event through, so one they stopped leaves it for the next.
  if (once)
    body.push('kayDone = true;')

  b.add(`${once ? '(() => { let kayDone = false; return ' : ''}(kayEvent) => { ${body.map(step => `${step} `).join('')}return (`).addSource(expression).add(`)?.(kayEvent) }${once ? ' })()' : ''}`)
}
