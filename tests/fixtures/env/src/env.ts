import { s } from 'kay'
import { defineEnv } from 'kay/server'

export const env = defineEnv(s.Object({ KAY_TEST_MAP_KEY: s.Public(s.String()), KAY_TEST_SERVER_ONLY: s.Optional(s.String()) }))
