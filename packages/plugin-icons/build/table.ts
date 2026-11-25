// Writes src/words.json from both tag sets and the meaning neighbours of every word a search may be typed with.
import { fromMeaning, fromTags, iconifyNameWords, lucideTags, merge, modelWords, setWords, tablerTags } from './learn'
import { FLOOR, MEANING_WEIGHT, NEIGHBOURS } from './settings'

const sets = [await tablerTags(), await lucideTags()]
const candidates = [...await iconifyNameWords()]
const keys = [...new Set([...await modelWords(), ...setWords(sets), ...candidates])]
const table = merge(fromTags(sets), await fromMeaning(keys, candidates, NEIGHBOURS, FLOOR), MEANING_WEIGHT)
const text = `${JSON.stringify(table, null, 0)}\n`

await Bun.write(`${import.meta.dir}/../src/words.json`, text)
console.log(`${Object.keys(table).length} words, ${candidates.length} icon-name words, ${(text.length / 1e6).toFixed(2)} MB`)
