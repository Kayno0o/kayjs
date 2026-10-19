import { t } from 'elysia'
import { defineEnv } from '../../src/server'

export const env = defineEnv(t.Object({
  MEDIA_DIR: t.String({ default: 'media' }),
  DEBUG: t.Optional(t.Boolean()),
}), { MEDIA_DIR: undefined, DEBUG: 'true' })

export const mediaDir = (): string => env.MEDIA_DIR
