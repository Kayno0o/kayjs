import { defineConfig } from '@kaynooo/eslint'

export default defineConfig({}, {
  // Tests embed .kay sources, whose expressions hold JS template literals inside plain strings.
  files: ['**/tests/**/*.ts'],
  rules: { 'no-template-curly-in-string': 'off' },
})
