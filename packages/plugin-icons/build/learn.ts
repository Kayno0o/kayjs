import type { FeatureExtractionPipeline } from '@huggingface/transformers'
import { pipeline } from '@huggingface/transformers'
import { nameWords } from '../src/name-words'

// An icon set's names with the tags its makers wrote for each.
export type Tagged = Map<string, string[]>

export type Related = Map<string, Map<string, number>>

const DIMENSIONS = 384
const BATCH = 512
const MODEL = 'Xenova/bge-small-en-v1.5'
const CACHE = `${import.meta.dir}/.cache`
const MODULES = `${import.meta.dir}/node_modules`
const WHOLE_WORD = /^[a-z]{3,}$/
// Keeps a table line to the strongest words, and drops those under 5%.
const KEPT = 12
const WEAKEST = 0.05

export async function tablerTags(): Promise<Tagged> {
  const icons = await Bun.file(`${MODULES}/@tabler/icons/icons.json`).json() as Record<string, { name: string, tags: (string | number)[] }>

  return new Map(Object.values(icons).map(icon => [icon.name, icon.tags.map(String)]))
}

export async function lucideTags(): Promise<Tagged> {
  return new Map(Object.entries(await Bun.file(`${MODULES}/lucide-static/tags.json`).json() as Record<string, string[]>))
}

// The names of every iconify set installed here, as the words their icons are named with.
export async function iconifyNameWords(): Promise<Set<string>> {
  const found = new Set<string>()

  for (const folder of new Bun.Glob('@iconify-json/*/icons.json').scanSync(MODULES)) {
    const set = await Bun.file(`${MODULES}/${folder}`).json() as { icons: Record<string, unknown>, aliases?: Record<string, unknown> }

    for (const name of [...Object.keys(set.icons), ...Object.keys(set.aliases ?? {})]) {
      for (const word of nameWords(name))
        found.add(word)
    }
  }

  return found
}

export function setWords(sets: Tagged[]): Set<string> {
  return new Set(sets.flatMap(set => [...set].flatMap(([name, tags]) => [...nameWords(name), ...tags.flatMap(nameWords)])))
}

function add(related: Related, from: string, to: string, weight: number): void {
  const row = related.get(from) ?? new Map<string, number>()

  related.set(from, row)
  row.set(to, (row.get(to) ?? 0) + weight)
}

// Each tag word to the name words of the icons it tags, by how often they meet against how common both are.
export function fromTags(sets: Tagged[]): Related {
  const pairs: Related = new Map()
  const tagUses = new Map<string, number>()
  const nameUses = new Map<string, number>()

  for (const set of sets) {
    for (const [name, tags] of set) {
      const names = new Set(nameWords(name))
      const words = new Set([...tags.flatMap(nameWords), ...names])

      for (const word of names)
        nameUses.set(word, (nameUses.get(word) ?? 0) + 1)

      for (const word of words) {
        tagUses.set(word, (tagUses.get(word) ?? 0) + 1)

        for (const target of names) {
          if (target !== word)
            add(pairs, word, target, 1)
        }
      }
    }
  }

  const related: Related = new Map()

  for (const [word, row] of pairs) {
    for (const [target, together] of row)
      add(related, word, target, together / Math.sqrt(tagUses.get(word)! * nameUses.get(target)!))
  }

  return related
}

let extractor: FeatureExtractionPipeline | undefined

// Each word's bge-small vector, cached on disk by word so a rebuild embeds only new words.
export async function vectors(words: string[]): Promise<Map<string, Float32Array>> {
  const file = Bun.file(`${CACHE}/vectors.json`)
  const cached = new Map<string, number[]>(await file.exists() ? Object.entries(await file.json() as Record<string, number[]>) : [])
  const missing = words.filter(word => !cached.has(word))

  if (missing.length > 0) {
    extractor ??= await pipeline('feature-extraction', MODEL, { dtype: 'q8' })

    for (let i = 0; i < missing.length; i += BATCH) {
      const batch = missing.slice(i, i + BATCH)
      const tensor = await extractor(batch, { pooling: 'cls', normalize: true })
      const data = tensor.data as Float32Array

      for (const [j, word] of batch.entries())
        cached.set(word, [...data.subarray(j * DIMENSIONS, (j + 1) * DIMENSIONS)].map(value => Math.round(value * 1e4) / 1e4))
    }

    await Bun.write(file, JSON.stringify(Object.fromEntries(cached)))
  }

  return new Map(words.map(word => [word, Float32Array.from(cached.get(word)!)]))
}

// The whole words of the model's own vocabulary: about 21,000 common English words a search may be typed with.
export async function modelWords(): Promise<string[]> {
  extractor ??= await pipeline('feature-extraction', MODEL, { dtype: 'q8' })
  const tokenizer = await Bun.file(`${MODULES}/@huggingface/transformers/.cache/${MODEL}/tokenizer.json`).json() as { model: { vocab: Record<string, number> } }

  return Object.keys(tokenizer.model.vocab).filter(token => WHOLE_WORD.test(token))
}

// Each key word to its nearest candidate words by meaning, scaled so `floor` similarity counts 0 and identical counts 1.
export async function fromMeaning(keys: string[], candidates: string[], keep: number, floor: number): Promise<Related> {
  const all = await vectors([...new Set([...keys, ...candidates])])
  // One flat matrix, as a loop over a single typed array is several times faster than one array per word.
  const matrix = new Float32Array(candidates.length * DIMENSIONS)

  for (const [i, word] of candidates.entries())
    matrix.set(all.get(word)!, i * DIMENSIONS)

  const related: Related = new Map()

  for (const key of keys) {
    const a = all.get(key)!
    const best: [string, number][] = []

    for (let i = 0; i < candidates.length; i++) {
      let dot = 0
      const start = i * DIMENSIONS

      for (let d = 0; d < DIMENSIONS; d++)
        dot += a[d]! * matrix[start + d]!

      if (dot >= floor && candidates[i] !== key)
        best.push([candidates[i]!, (dot - floor) / (1 - floor)])
    }

    for (const [word, weight] of best.sort((x, y) => y[1] - x[1]).slice(0, keep))
      add(related, key, word, weight)
  }

  return related
}

// Both sources summed per word pair, meaning weighted by `meaningWeight`, as the `word percent word percent` lines the runtime reads.
export function merge(tags: Related, meaning: Related, meaningWeight: number): Record<string, string> {
  const merged: Related = new Map()

  for (const [word, row] of tags) {
    for (const [target, weight] of row)
      add(merged, word, target, weight)
  }

  for (const [word, row] of meaning) {
    for (const [target, weight] of row)
      add(merged, word, target, weight * meaningWeight)
  }

  const table: Record<string, string> = {}

  for (const word of [...merged.keys()].sort()) {
    const kept = [...merged.get(word)!]
      .map(([target, weight]) => [target, Math.min(1, weight)] as const)
      .filter(([, weight]) => weight >= WEAKEST)
      .sort((a, b) => b[1] - a[1])
      .slice(0, KEPT)

    if (kept.length > 0)
      table[word] = kept.map(([target, weight]) => `${target} ${Math.round(weight * 100)}`).join(' ')
  }

  return table
}
