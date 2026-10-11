import { defineMessages } from 'kay/i18n'

// The wording of kayjs-auth's mails as `authMailer` renders them, which an app overrides key by key in its own `src/messages/<locale>.ts`. Placeholders: `{site}`, `{email}`, the address written to, and `{detail}`, the organization, provider, passkey, token or new address a mail is about.
export default defineMessages({
  mail: {
    auth: {
      'link': 'link',
      'code': 'code',
      'orPaste': 'Or paste this into your browser:',
      'yourCode': 'Your code:',
      'orTypeCode': 'Or type this code where you asked for it:',
      'linkWorks': 'The link works for {duration}.',
      'codeWorks': 'The code works for 10 minutes, typed where you asked for it.',
      'review': 'See where your account is signed in, and end what you do not know:',
      'verify-email': {
        subject: 'Confirm your email for {site}',
        lead: 'Confirm {email} as the address of your {site} account.',
        button: 'Confirm my email',
        lasts: '24 hours',
        ending: 'If you did not create an account, ignore this mail.',
      },
      'reset-password': {
        subject: 'Reset your {site} password',
        lead: 'Someone asked to reset the password of the {site} account for {email}.',
        button: 'Choose a new password',
        lasts: 'one hour',
        ending: 'If you did not ask for it, ignore this mail: your password stays as it is.',
      },
      'magic-link': {
        subject: 'Sign in to {site}',
        lead: 'Here is your {what} to sign in to {site}.',
        button: 'Sign in',
        lasts: '15 minutes, once',
        ending: 'If you did not ask for it, ignore this mail.',
      },
      'change-email': {
        subject: 'Confirm your new email for {site}',
        lead: 'Confirm {email} as the new address of your {site} account.',
        button: 'Confirm the change',
        lasts: 'one hour',
        ending: 'If you did not ask for this change, ignore this mail.',
      },
      'invitation': {
        subject: 'Join {detail} on {site}',
        lead: 'You are invited to join {detail} on {site}, with an account at {email}.',
        button: 'See the invitation',
        lasts: '',
        ending: 'If you did not expect it, ignore this mail.',
      },
      'new-sign-in': {
        subject: 'New sign-in on {site}',
        lead: 'Your {site} account was just signed into from a device or network it had not used before.',
        ending: 'If this was not you, reset your password and check your account at once.',
      },
      'password-changed': {
        subject: 'Password changed on {site}',
        lead: 'The password of your {site} account was changed, and its other sessions signed out.',
        ending: 'If this was not you, reset your password and check your account at once.',
      },
      'email-changed': {
        subject: 'Email changed on {site}',
        lead: 'Your {site} account moved from {email} to {detail}. This address no longer signs into it.',
        ending: 'If this was not you, contact the site at once.',
      },
      'two-factor-enabled': {
        subject: 'Two-factor turned on on {site}',
        lead: 'Your {site} account now asks for a code from your authenticator when signing in.',
        ending: 'If this was not you, reset your password and check your account at once.',
      },
      'two-factor-disabled': {
        subject: 'Two-factor turned off on {site}',
        lead: 'Your {site} account no longer asks for a code when signing in.',
        ending: 'If this was not you, reset your password and check your account at once.',
      },
      'recovery-code-used': {
        subject: 'Recovery code used on {site}',
        lead: 'A recovery code was just used on your {site} account; it will not work again.',
        ending: 'If this was not you, reset your password and check your account at once.',
      },
      'recovery-codes-regenerated': {
        subject: 'New recovery codes on {site}',
        lead: 'Your {site} account has a new set of recovery codes, and the old ones no longer work.',
        ending: 'If this was not you, reset your password and check your account at once.',
      },
      'provider-linked': {
        subject: 'Account linked on {site}',
        lead: 'A {detail} account can now sign into your {site} account.',
        ending: 'If this was not you, reset your password and check your account at once.',
      },
      'provider-unlinked': {
        subject: 'Account unlinked on {site}',
        lead: 'Your {detail} account no longer signs into your {site} account.',
        ending: 'If this was not you, reset your password and check your account at once.',
      },
      'passkey-added': {
        subject: 'New passkey on {site}',
        lead: 'A passkey named {detail} can now sign into your {site} account.',
        ending: 'If this was not you, reset your password and check your account at once.',
      },
      'passkey-removed': {
        subject: 'Passkey removed on {site}',
        lead: 'The passkey named {detail} no longer signs into your {site} account.',
        ending: 'If this was not you, reset your password and check your account at once.',
      },
      'token-created': {
        subject: 'New access token on {site}',
        lead: 'An access token named {detail} was created for your {site} account.',
        ending: 'If this was not you, reset your password and check your account at once.',
      },
      'signed-out-everywhere': {
        subject: 'Signed out everywhere on {site}',
        lead: 'Your {site} account was signed out everywhere: every session and access token it had has ended.',
        ending: 'If this was not you, reset your password and check your account at once.',
      },
      'account-deleted': {
        subject: 'Account deleted on {site}',
        lead: 'Your {site} account was deleted.',
        ending: 'If this was not you, contact the site at once.',
      },
    },
  },
})
