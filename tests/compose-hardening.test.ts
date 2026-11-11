import { describe, expect, it } from 'bun:test'
import { databaseCompose } from '../src/template-docker'

// A service's block of the scaffolded compose file, from its name to the next service.
function service(compose: string, name: string): string {
  return compose.split(/^ {2}(?=\w[\w-]*:$)/m).find(block => block.startsWith(`${name}:`)) ?? ''
}

describe('the scaffolded compose files', () => {
  it('drop every capability on each Postgres service, the database keeping only what its entrypoint needs', () => {
    const compose = databaseCompose(true)

    for (const name of ['db', 'migrate', 'app']) {
      expect(service(compose, name)).toContain('cap_drop: [ALL]')
      expect(service(compose, name)).toContain('no-new-privileges:true')
    }

    expect(service(compose, 'db')).toContain('cap_add: [CHOWN, DAC_OVERRIDE, FOWNER, SETGID, SETUID]')
    expect(service(compose, 'migrate')).not.toContain('cap_add')
  })

  it('keeps the SQLite app service without capabilities', () => {
    expect(service(databaseCompose(false), 'app')).toContain('cap_drop: [ALL]')
  })
})
