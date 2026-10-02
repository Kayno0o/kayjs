// Deterministic data every app renders, so the three frameworks do exactly the same work.

export interface Product {
  id: number
  name: string
  price: number
  stock: number
  tags: string[]
}

export interface Row {
  id: number
  label: string
}

const ADJECTIVES = ['pretty', 'large', 'big', 'small', 'tall', 'short', 'long', 'handsome', 'plain', 'quaint', 'clean', 'elegant', 'easy', 'angry', 'crazy', 'helpful', 'mushy', 'odd', 'unsightly', 'adorable', 'important', 'inexpensive', 'cheap', 'expensive', 'fancy']
const COLOURS = ['red', 'yellow', 'blue', 'green', 'pink', 'brown', 'purple', 'brown', 'white', 'black', 'orange']
const NOUNS = ['table', 'chair', 'house', 'bbq', 'desk', 'car', 'pony', 'cookie', 'sandwich', 'burger', 'pizza', 'mouse', 'keyboard']
const TAGS = ['new', 'sale', 'eco', 'popular', 'limited', 'imported', 'handmade', 'bundle']
const PRODUCT_COUNT = 500

// Mulberry32: a tiny seeded generator, so every run and every framework sees the same sequence.
export function random(seed: number): () => number {
  let state = seed

  return () => {
    state = (state + 0x6D2B79F5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)

    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t)

    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function pick<T>(next: () => number, list: readonly T[]): T {
  return list[Math.floor(next() * list.length)]!
}

export function buildProducts(count: number): Product[] {
  const next = random(42)

  return Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    name: `${pick(next, ADJECTIVES)} ${pick(next, COLOURS)} ${pick(next, NOUNS)}`,
    price: Math.round(next() * 100_000) / 100,
    stock: next() < 0.2 ? 0 : Math.floor(next() * 50),
    tags: TAGS.filter(() => next() < 0.3),
  }))
}

export const PRODUCTS = buildProducts(PRODUCT_COUNT)

export function formatPrice(price: number): string {
  return `$${price.toFixed(2)}`
}

// js-framework-benchmark rows: ids keep growing across calls, labels come from the seeded generator.
export function rowBuilder(seed = 7): (count: number) => Row[] {
  const next = random(seed)
  let id = 1

  return count => Array.from({ length: count }, () => ({ id: id++, label: `${pick(next, ADJECTIVES)} ${pick(next, COLOURS)} ${pick(next, NOUNS)}` }))
}
