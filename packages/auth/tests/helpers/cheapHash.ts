import { PASSWORD_HASH_PARAMS } from '@kaynooo/utils'

// Preloaded: argon2id at its production cost takes about 100 ms a hash, so tests hash at the lowest cost Bun allows, which `passwordNeedsRehash` reads as current too.
const params = PASSWORD_HASH_PARAMS as { memoryCost: number, timeCost: number }
const production = { ...params }
const cheap = { memoryCost: 8, timeCost: 1 }

Object.assign(params, cheap)

// Runs `test` hashing at the production cost, for a test about the hash itself.
export function productionHash(test: () => Promise<void>) {
  return async () => {
    Object.assign(params, production)

    try {
      await test()
    }
    finally {
      Object.assign(params, cheap)
    }
  }
}
