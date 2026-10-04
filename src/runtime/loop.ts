import type { JSX } from '@solidjs/web'
import { createComponent, For } from 'solid-js'

// Solid keeps each row's item in a signal, and a signal takes a function as an updater, so a loop over components would call them instead of keeping them.
// A function item goes in boxed, one box per function so its row keeps its identity, and comes out as itself.
class FunctionItem {
  constructor(readonly value: unknown) {}
}

const boxes = new WeakMap<object, FunctionItem>()

function boxed(item: unknown): unknown {
  if (typeof item !== 'function')
    return item

  let box = boxes.get(item)

  if (!box)
    boxes.set(item, box = new FunctionItem(item))

  return box
}

function unboxed(item: unknown): unknown {
  return item instanceof FunctionItem ? item.value : item
}

const holdsFunction = (item: unknown) => typeof item === 'function'

// Solid's `For`, for a template's `for`: the same props, function items included.
export const loopFor = ((props: { each: readonly unknown[] | null | undefined | false, keyed?: boolean | ((item: unknown) => unknown), fallback?: JSX.Element, children: (item: () => unknown, index: unknown) => JSX.Element }) => {
  const keyed = props.keyed

  return createComponent(For, {
    get each() {
      const each = props.each

      return each && each.some(holdsFunction) ? each.map(boxed) : each
    },
    keyed: typeof keyed === 'function' ? (item: unknown) => keyed(unboxed(item)) : keyed,
    get fallback() {
      return props.fallback
    },
    children: (item: () => unknown, index: unknown) => props.children(() => unboxed(item()), index),
  } as never)
}) as unknown as typeof For
