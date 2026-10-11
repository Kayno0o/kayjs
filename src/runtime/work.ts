// SHA-256's constants, the fractional parts of the cube roots of the first 64 primes and the square roots of the first 8, worked out rather than written out.
const PRIMES = Array.from({ length: 312 }, (_, n) => n).filter(n => n > 1 && Array.from({ length: n - 2 }, (_, d) => d + 2).every(d => n % d !== 0))
const ROUNDS = Uint32Array.from(PRIMES, prime => (Math.cbrt(prime) % 1) * 2 ** 32)
const START = Uint32Array.from(PRIMES.slice(0, 8), prime => (Math.sqrt(prime) % 1) * 2 ** 32)

// The SHA-256 of an ASCII text shorter than 56 characters, which fits one block: all a challenge hashes, and in plain script as `crypto.subtle` costs a promise per hash and is missing outside HTTPS.
export function digest(text: string, words = new Uint32Array(64), into = new Uint32Array(8)): Uint32Array {
  words.fill(0, 0, 16)

  for (let index = 0; index < text.length; index++)
    words[index >> 2]! |= text.charCodeAt(index) << (24 - (index & 3) * 8)

  words[text.length >> 2]! |= 0x80 << (24 - (text.length & 3) * 8)
  words[15] = text.length * 8

  for (let index = 16; index < 64; index++) {
    const a = words[index - 15]!
    const b = words[index - 2]!

    words[index] = words[index - 16]! + (((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3)) + words[index - 7]! + (((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10))
  }

  let [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0, g = 0, h = 0] = START

  for (let index = 0; index < 64; index++) {
    const one = h + (((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7))) + ((e & f) ^ (~e & g)) + ROUNDS[index]! + words[index]!
    const two = (((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10))) + ((a & b) ^ (a & c) ^ (b & c))

    h = g
    g = f
    f = e
    e = (d + one) | 0
    d = c
    c = b
    b = a
    a = (one + two) | 0
  }

  into[0] = START[0]! + a
  into[1] = START[1]! + b
  into[2] = START[2]! + c
  into[3] = START[3]! + d
  into[4] = START[4]! + e
  into[5] = START[5]! + f
  into[6] = START[6]! + g
  into[7] = START[7]! + h

  return into
}

export function sha256(text: string): string {
  return [...digest(text)].map(word => word.toString(16).padStart(8, '0')).join('')
}

// A challenge is `<expires, base 36>.<salt>.<hash>.<difficulty, base 36>.<signature>`; its solution is the challenge and the number whose hash with the salt it gives, undefined for one that is not a challenge.
export function solveWork(challenge: string): string | undefined {
  const [, salt = '', hash = '', most = ''] = challenge.split('.')
  const target = Uint32Array.from(hash.match(/.{8}/g) ?? [], word => Number.parseInt(word, 16))
  const words = new Uint32Array(64)
  const found = new Uint32Array(8)
  const last = Number.parseInt(most, 36)

  if (target.length !== 8 || salt.length > 40)
    return undefined

  for (let number = 0; number <= last; number++) {
    digest(salt + number, words, found)

    if (found[0] === target[0] && found.every((word, index) => word === target[index]))
      return `${challenge}.${number}`
  }

  return undefined
}
