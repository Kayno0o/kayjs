import type { BareUser } from './core'
import type { ProfileFieldView, ProfileOptions, ProfileProblem } from './pages'
import { profileLabel, profileValue } from './pages'
import { PROFILE_MAX_LENGTH } from './rules'

export type SaveProfileResult = { ok: true } | { ok: false, error: 'signed-out' } | { ok: false, errors: Record<string, ProfileProblem> }

// The fields of the profile form with what `user` holds in each.
export async function profileFields(profile: ProfileOptions, user: BareUser, locale: string | undefined): Promise<ProfileFieldView[]> {
  const held = await profile.load(user)

  return Object.entries(profile.fields).map(([name, field]) => ({ ...field, label: profileLabel(field.label, locale), name, maxLength: field.maxLength ?? PROFILE_MAX_LENGTH, value: profileValue(name, Object.hasOwn(held, name) ? held[name] : undefined) }))
}

// The values posted from the form, trimmed and checked against each field's `required` and `maxLength`; nothing is stored while any field is refused.
export async function saveProfile(profile: ProfileOptions, user: BareUser, values: Record<string, unknown>): Promise<{ ok: true } | { ok: false, errors: Record<string, ProfileProblem> }> {
  const clean: Record<string, string> = {}
  const errors: Record<string, ProfileProblem> = {}

  for (const [name, field] of Object.entries(profile.fields)) {
    const raw = Object.hasOwn(values, name) ? values[name] : undefined
    const value = typeof raw === 'string' ? raw.trim() : ''

    clean[name] = value

    if (value === '' && field.required)
      errors[name] = 'required'
    else if (value.length > (field.maxLength ?? PROFILE_MAX_LENGTH))
      errors[name] = 'too-long'
  }

  if (Object.keys(errors).length > 0)
    return { ok: false, errors }

  const refused = await profile.save(user, clean)

  if (!refused)
    return { ok: true }

  return { ok: false, errors: Object.fromEntries(Object.entries(refused.errors).flatMap(([name, message]) => typeof message === 'string' && Object.hasOwn(profile.fields, name) ? [[name, { message }]] : [])) }
}
