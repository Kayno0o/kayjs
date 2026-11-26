import type { StandardSchemaV1 } from '@kayjs/kay/server'
import { action } from '@kayjs/kay/server'

export interface Preferences {
  project: string
  strict: boolean
  compile: boolean
  deploy: 'binary' | 'static'
}

const prefsSchema: StandardSchemaV1<unknown, Preferences> = {
  '~standard': {
    version: 1,
    vendor: 'showcase',
    validate(raw) {
      const d = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
      const project = typeof d.project === 'string' && d.project.trim() ? d.project.trim() : 'my-kay-app'
      const deploy = d.deploy === 'static' ? 'static' : 'binary'
      return {
        value: {
          project,
          strict: d.strict === 'on' || d.strict === true,
          compile: d.compile === 'on' || d.compile === true,
          deploy,
        },
      }
    },
  },
}

export const savePreferences = action(prefsSchema, (prefs, ctx) => {
  ctx.cookies.set('showcase_prefs', JSON.stringify(prefs), { path: '/', maxAge: 60 * 60 * 24 })
  return ctx.redirect('/?saved=1', 303)
})
