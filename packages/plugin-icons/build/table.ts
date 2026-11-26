// Writes src/words.json from the tag sets, the aliases of every installed set and the meaning neighbours of every word a search may be typed with.
import { packTable } from '../src/table'
import { aliasTags, fromMeaning, fromTags, iconifyNameWords, lucideTags, merge, modelWords, phosphorTags, setWords, tablerTags } from './learn'
import { FLOOR, MEANING_WEIGHT, NEIGHBOURS } from './settings'

const sets = [await tablerTags(), await lucideTags(), await phosphorTags(), await aliasTags()]
const candidates = [...await iconifyNameWords()]
const keys = [...new Set([...await modelWords(), ...setWords(sets), ...candidates])]
const table = merge(fromTags(sets), await fromMeaning(keys, candidates, NEIGHBOURS, FLOOR), MEANING_WEIGHT)
const text = `${JSON.stringify(packTable(table))}\n`

await Bun.write(`${import.meta.dir}/../src/words.json`, text)
console.log(`${Object.keys(table).length} words, ${candidates.length} icon-name words, ${(text.length / 1e6).toFixed(2)} MB`)
