import type { MaybePromise } from '../runtime/store-base'

// What a library keeps about a signed-in user, so erasing or exporting a person reaches it with nothing declared by the app.
export interface PersonalDataSource {
  // Names the source in an export, such as `ai`.
  name: string
  // Deletes everything kept about the user, `user` being the id `userOf` names, and answers how many records went.
  erase: (user: string) => MaybePromise<number>
  // What is kept about the user, as JSON.
  export: (user: string) => MaybePromise<unknown>
}

const SLOT = Symbol.for('kay.personalData')

// On the global, so every copy of kay in the process shares the sources the libraries registered.
function sources(): Map<string, PersonalDataSource> {
  const holder = globalThis as { [SLOT]?: Map<string, PersonalDataSource> }

  return holder[SLOT] ??= new Map()
}

export const personalData = {
  // Adds a source, replacing the one of the same name, as a config run again on a reload registers its libraries again.
  register(source: PersonalDataSource): void {
    sources().set(source.name, source)
  },
  // Takes a source back out, for a test.
  unregister(name: string): void {
    sources().delete(name)
  },
  // Erases the user from every source, all of them tried before the first failure is thrown.
  async erase(user: string): Promise<number> {
    const results = await Promise.allSettled([...sources().values()].map(async source => source.erase(user)))
    const failed = results.find(result => result.status === 'rejected')

    if (failed)
      throw failed.reason

    return results.reduce((sum, result) => sum + (result.status === 'fulfilled' ? result.value : 0), 0)
  },
  // What each source keeps about the user, by its name; a source with nothing to say is left out.
  async export(user: string): Promise<Record<string, unknown>> {
    const found = await Promise.all([...sources().values()].map(async source => [source.name, await source.export(user)] as const))

    return Object.fromEntries(found.filter(([, data]) => data !== undefined && data !== null))
  },
}
