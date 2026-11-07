import type { ChangeUsernameResult, DeleteAccountResult, UpdateLocaleResult } from '../account'
import type { DeletionImpact } from '../erase'
import type { ExportResult } from '../export'
import type { ProfileFieldView } from '../pages'
import type { SaveProfileResult } from '../profile'
import type { Proof } from '../proof'
import type { RequestState } from '../state'
import { publicUser } from '../core'
import { failed } from '../failure'
import { load } from '../load'

// `auth.account`: the signed-in user's own account.
export class AccountMethods {
  constructor(private readonly state: RequestState) {}

  // Names the signed-in user, or renames them, under the rules register checks; no proof, a name being no credential.
  async changeUsername(username: string): Promise<ChangeUsernameResult> {
    return (await load.account()).changeUsername(this.state, username)
  }

  // Sets the language the signed-in user's mails are written in, a BCP 47 tag such as `fr`; refused with `signed-out`, or `invalid-locale` for anything else than a tag.
  async updateLocale(locale: string): Promise<UpdateLocaleResult> {
    return (await load.account()).updateLocale(this.state, locale)
  }

  // Deletes the signed-in user, calling `onDelete` for the app's own records, and signs this session out; the last admin and the only owner of an organization with other members are refused, an organization they are alone in is deleted with them.
  async delete(proof: Proof): Promise<DeleteAccountResult> {
    return (await load.account()).deleteAccount(this.state, proof, this.state.signOut)
  }

  // The organizations deleting the signed-in user's account touches, by name: `deleted` are the ones they are the only member of, which go with them, `blocked` the ones they solely own with other members, which refuse the deletion (`last-owner`) until another owner is named.
  async deletionImpact(): Promise<DeletionImpact> {
    return (await load.erase()).deletionImpact(this.state)
  }

  // The fields of the profile form the account page shows beside the username, with what this user holds in each, or null when `pages.profile` is not set or the user is not signed in with a session.
  async profile(locale?: string): Promise<ProfileFieldView[] | null> {
    const profile = this.state.core.pages?.profile
    const record = profile && await this.state.current()

    if (!profile || !record || this.state.via() !== 'session')
      return null

    return (await load.profile()).profileFields(profile, publicUser(record), locale)
  }

  // Stores the values posted from that form through `pages.profile.save`, once trimmed and checked against each field's `required` and `maxLength`: names that are no field are dropped, and nothing is stored while any field is refused.
  async saveProfile(values: Record<string, unknown>): Promise<SaveProfileResult> {
    const profile = this.state.core.pages?.profile

    if (!profile)
      throw new Error('kayjs-auth: account.saveProfile needs `pages.profile` in authCore')

    const record = await this.state.current()

    // A device's token cannot edit the profile of the account it was given for, as it cannot rename it.
    if (!record || this.state.via() !== 'session')
      return failed('signed-out')

    return (await load.profile()).saveProfile(profile, publicUser(record), values)
  }

  // Everything kayjs-auth keeps about the signed-in user, secrets left out, with the app's own from `exportData`: for a download of their data.
  async export(): Promise<ExportResult> {
    return (await load.exports()).exportData(this.state)
  }
}
