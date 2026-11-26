import { build } from '@kayjs/kay/build'

const start = performance.now()
const manifest = await build({ root: import.meta.dir })
const ms = performance.now() - start

console.log(`Built in ${ms.toFixed(1)} ms (${manifest.assets.length} client assets)`)
