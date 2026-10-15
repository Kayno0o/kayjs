// Draws kay's default favicon PNG from its SVG at 512 pixels, the widest icon kay makes from it, so the two never drift apart: `bun scripts/favicon.ts`.
import { join } from 'node:path'
import { svgIcon } from '../src/server/svg-icon'

const DIR = join(import.meta.dir, '../src/server')
const SIZE = 512

const draw = await svgIcon(join(DIR, 'favicon.svg'), 'favicon')

await Bun.write(join(DIR, 'favicon.png'), draw(SIZE))
