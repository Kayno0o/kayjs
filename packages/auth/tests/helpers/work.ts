// The solution kay's script posts for a proof-of-work challenge, `<challenge>.<number>`: the number up to the challenge's difficulty whose hash with its salt is the challenge's.
export function solve(challenge: string): string {
  const [, salt = '', hash = '', most = ''] = challenge.split('.')

  for (let number = 0; number <= Number.parseInt(most, 36); number++) {
    if (new Bun.CryptoHasher('sha256').update(salt + number).digest('hex') === hash)
      return `${challenge}.${number}`
  }

  throw new Error(`no number solves ${challenge}`)
}

// The difficulty a challenge was signed with.
export function difficultyOf(challenge: string): number {
  return Number.parseInt(challenge.split('.')[3]!, 36)
}
