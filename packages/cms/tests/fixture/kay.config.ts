import { defineConfig } from 'kay/server'
import { cms } from '../../src/extension'

export default defineConfig({ extensions: [cms()] })
