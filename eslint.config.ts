import { defineConfig } from '@kaynooo/eslint'

export default defineConfig({
  strict: true,
  // The fixtures are apps of their own, outside the tsconfig. The Astro, Next and Nuxt bench apps are type-checked by their own tools in `bench:check`: their programs loaded here too run eslint out of memory.
  filesTypeAware: ['*.ts', 'src/**/*.ts', 'tests/*.ts', 'bench/*.ts', 'bench/{shared,sites}/**/*.ts', 'bench/apps/{kay,solid,svelte}/**/*.ts'],
}, {
  rules: { 'ts/no-explicit-any': 'error' },
}, {
  files: ['**/tests/**/*.ts'],
  rules: {
    // Tests embed .kay sources, whose expressions hold JS template literals inside plain strings.
    'no-template-curly-in-string': 'off',
    // bun-types types the matchers of `expect(promise).rejects` as returning void, though they must be awaited.
    'ts/await-thenable': 'off',
    // Tests run the inline scripts kay writes into a page.
    'ts/no-implied-eval': 'off',
    // bun-types types the asymmetric matchers, `expect.stringContaining()` and the like, as any.
    'ts/no-unsafe-argument': 'off',
  },
})
