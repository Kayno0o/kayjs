import { guard } from 'kay'
import { defineConfig } from 'kay/server'
import { cms } from '../../src/extension'
import { recorder } from './src/saved'

// The fixture lets everyone into the screens, and keeps the files they save.
export default defineConfig({
  extensions: [cms({ guard: guard(() => undefined), files: recorder })],
  preview: { secret: 'a-preview-secret-long-enough-for-kay-0123456789' },
})
