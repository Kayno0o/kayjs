// Rewrites src/server/public-suffixes.ts from the Public Suffix List: `bun scripts/public-suffixes.ts [path to a downloaded list]`.
import { gzipSync } from 'bun'

const SOURCE = 'https://publicsuffix.org/list/public_suffix_list.dat'
const OUTPUT = new URL('../src/server/public-suffixes.ts', import.meta.url).pathname
const WIDTH = 120

const [file] = Bun.argv.slice(2)
const text = file === undefined ? await (await fetch(SOURCE)).text() : await Bun.file(file).text()
const version = /^\/\/ VERSION: (\S+)/m.exec(text)?.[1] ?? 'unknown'
const rules = text.split('\n').map(line => line.trim()).filter(line => line !== '' && !line.startsWith('//'))
const packed = Buffer.from(gzipSync(rules.join('\n'))).toString('base64')
const lines = packed.match(new RegExp(`.{1,${WIDTH}}`, 'g')) ?? []

await Bun.write(OUTPUT, `// The Public Suffix List (https://publicsuffix.org/list/), version ${version}, under the Mozilla Public License 2.0: one rule per line, gzipped and base64.
// Written by scripts/public-suffixes.ts, which fetches the list again.
export const PUBLIC_SUFFIX_VERSION = '${version}'

export const PUBLIC_SUFFIX_RULES = [
${lines.map(line => `  '${line}',`).join('\n')}
].join('')
`)
console.log(`${rules.length} rules, ${packed.length} bytes packed`)
