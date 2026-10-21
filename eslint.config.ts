import { defineConfig } from '@kaynooo/eslint'
import { kayRules } from './eslint.base'
import { filesTypeAware } from './eslint.slices'

// The libraries under packages/ lint with their own, each in a process of its own (`bun run lint`): one process holding every type-aware program runs out of memory.
export default defineConfig({
  strict: true,
  kay: true,
  filesTypeAware,
}, {
  // Emscripten's glue, as codecs/avif/build.ts writes it.
  ignores: ['src/server/codec/avif-enc.js', 'tests/fixtures/**/*.kay'],
}, kayRules)
