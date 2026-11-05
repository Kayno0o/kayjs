import type { AuthProofOfWorkOptions } from './captcha'
import type { AuthMember } from './organizations'
import { authGuard } from './guard'

/** @deprecated Renamed `authGuard` in 1.90, as kay has a `guard` of its own; the old name works until 1.93. */
export const guard = authGuard

/** @deprecated Renamed `AuthMember` in 1.90, as kayjs-cms has a `Member` of its own; the old name works until 1.93. */
export type Member<Role extends string = string> = AuthMember<Role>

/** @deprecated Renamed `AuthProofOfWorkOptions` in 1.90, as `kay` has a `ProofOfWorkOptions` of its own; the old name works until 1.93. */
export type ProofOfWorkOptions = AuthProofOfWorkOptions
