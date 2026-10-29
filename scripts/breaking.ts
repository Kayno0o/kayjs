export const BREAKING_FILE = 'api/breaking.txt'

// Until 2.0.0 a breaking change ships in a 1.x minor, which clears the list; a patch never does, and from 2.0.0 only a major does. The 1.x allowance goes with the semver switch: #2595 box 5.
export function breakingRefused(level: 'major' | 'minor' | 'patch', current: string, breaking: string): boolean {
  if (breaking === '' || level === 'major')
    return false

  return level === 'patch' || !current.startsWith('1.')
}
