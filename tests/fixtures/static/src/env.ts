import { s } from 'kay'
import { defineEnv } from 'kay/server'

export const env = defineEnv(s.Object({ KAY_TEST_STATIC_KEY: s.Public(s.String({ default: 'static-key' })) }))
