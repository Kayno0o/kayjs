import { join } from 'node:path'
import { paletteStylesheet } from '../src/palettes'

await Bun.write(join(import.meta.dir, '../src/palettes.css'), paletteStylesheet())
