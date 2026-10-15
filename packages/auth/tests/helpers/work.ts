// The difficulty a challenge was signed with.
export function difficultyOf(challenge: string): number {
  return Number.parseInt(challenge.split('.')[3]!, 36)
}
