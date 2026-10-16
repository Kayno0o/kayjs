import { defineConfig } from '@kaynooo/eslint'
import { kayRules } from './eslint.base'

// The libraries under packages/ lint with their own, each in a process of its own (`bun run lint`): one process holding every type-aware program runs out of memory.
export default defineConfig({
  strict: true,
  kay: true,
  // The fixtures are apps of their own, outside the tsconfig. The Astro, Next and Nuxt bench apps are type-checked by their own tools in `bench:check`: their programs loaded here too run eslint out of memory.
  filesTypeAware: ['*.ts', 'scripts/*.ts', 'src/**/*.ts', 'tests/*.ts', 'bench/*.ts', 'bench/{shared,sites}/**/*.ts', 'bench/apps/{kay,solid,svelte}/**/*.ts'],
}, {
  // Emscripten's glue, as codecs/avif/build.ts writes it.
  ignores: ['src/server/codec/avif-enc.js', 'tests/fixtures/**/*.kay'],
}, kayRules)
