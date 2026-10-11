import { defineMessages } from 'kay/i18n'

export default defineMessages({
  mail: {
    auth: {
      'link': 'lien',
      'code': 'code',
      'orPaste': 'Ou collez ceci dans votre navigateur :',
      'yourCode': 'Votre code :',
      'orTypeCode': 'Ou saisissez ce code là où vous l\'avez demandé :',
      'linkWorks': 'Le lien est valable {duration}.',
      'codeWorks': 'Le code est valable 10 minutes, saisi là où vous l\'avez demandé.',
      'review': 'Voyez où votre compte est connecté, et mettez fin à ce que vous ne reconnaissez pas :',
      'verify-email': {
        subject: 'Confirmez votre adresse pour {site}',
        lead: 'Confirmez {email} comme adresse de votre compte {site}.',
        button: 'Confirmer mon adresse',
        lasts: '24 heures',
        ending: 'Si vous n\'avez pas créé de compte, ignorez ce message.',
      },
      'reset-password': {
        subject: 'Réinitialisez votre mot de passe {site}',
        lead: 'Quelqu\'un a demandé à réinitialiser le mot de passe du compte {site} de {email}.',
        button: 'Choisir un nouveau mot de passe',
        lasts: 'une heure',
        ending: 'Si vous ne l\'avez pas demandé, ignorez ce message : votre mot de passe reste inchangé.',
      },
      'magic-link': {
        subject: 'Connexion à {site}',
        lead: 'Voici votre {what} pour vous connecter à {site}.',
        button: 'Me connecter',
        lasts: '15 minutes, une seule fois',
        ending: 'Si vous ne l\'avez pas demandé, ignorez ce message.',
      },
      'change-email': {
        subject: 'Confirmez votre nouvelle adresse pour {site}',
        lead: 'Confirmez {email} comme nouvelle adresse de votre compte {site}.',
        button: 'Confirmer le changement',
        lasts: 'une heure',
        ending: 'Si vous n\'avez pas demandé ce changement, ignorez ce message.',
      },
      'invitation': {
        subject: 'Rejoignez {detail} sur {site}',
        lead: 'Vous êtes invité à rejoindre {detail} sur {site}, avec un compte à l\'adresse {email}.',
        button: 'Voir l\'invitation',
        lasts: '',
        ending: 'Si vous ne l\'attendiez pas, ignorez ce message.',
      },
      'new-sign-in': {
        subject: 'Nouvelle connexion sur {site}',
        lead: 'Votre compte {site} vient d\'être utilisé depuis un appareil ou un réseau qu\'il n\'avait jamais utilisé.',
        ending: 'Si ce n\'était pas vous, réinitialisez votre mot de passe et vérifiez votre compte sans attendre.',
      },
      'password-changed': {
        subject: 'Mot de passe modifié sur {site}',
        lead: 'Le mot de passe de votre compte {site} a été modifié, et ses autres sessions déconnectées.',
        ending: 'Si ce n\'était pas vous, réinitialisez votre mot de passe et vérifiez votre compte sans attendre.',
      },
      'email-changed': {
        subject: 'Adresse modifiée sur {site}',
        lead: 'Votre compte {site} est passé de {email} à {detail}. Cette adresse ne permet plus de s\'y connecter.',
        ending: 'Si ce n\'était pas vous, contactez le site sans attendre.',
      },
      'two-factor-enabled': {
        subject: 'Double authentification activée sur {site}',
        lead: 'Votre compte {site} demande désormais un code de votre application d\'authentification à chaque connexion.',
        ending: 'Si ce n\'était pas vous, réinitialisez votre mot de passe et vérifiez votre compte sans attendre.',
      },
      'two-factor-disabled': {
        subject: 'Double authentification désactivée sur {site}',
        lead: 'Votre compte {site} ne demande plus de code à la connexion.',
        ending: 'Si ce n\'était pas vous, réinitialisez votre mot de passe et vérifiez votre compte sans attendre.',
      },
      'recovery-code-used': {
        subject: 'Code de secours utilisé sur {site}',
        lead: 'Un code de secours vient d\'être utilisé sur votre compte {site} ; il ne fonctionnera plus.',
        ending: 'Si ce n\'était pas vous, réinitialisez votre mot de passe et vérifiez votre compte sans attendre.',
      },
      'recovery-codes-regenerated': {
        subject: 'Nouveaux codes de secours sur {site}',
        lead: 'Votre compte {site} a de nouveaux codes de secours, et les anciens ne fonctionnent plus.',
        ending: 'Si ce n\'était pas vous, réinitialisez votre mot de passe et vérifiez votre compte sans attendre.',
      },
      'provider-linked': {
        subject: 'Compte associé sur {site}',
        lead: 'Un compte {detail} peut désormais se connecter à votre compte {site}.',
        ending: 'Si ce n\'était pas vous, réinitialisez votre mot de passe et vérifiez votre compte sans attendre.',
      },
      'provider-unlinked': {
        subject: 'Compte dissocié sur {site}',
        lead: 'Votre compte {detail} ne permet plus de se connecter à votre compte {site}.',
        ending: 'Si ce n\'était pas vous, réinitialisez votre mot de passe et vérifiez votre compte sans attendre.',
      },
      'passkey-added': {
        subject: 'Nouvelle clé d\'accès sur {site}',
        lead: 'Une clé d\'accès nommée {detail} peut désormais se connecter à votre compte {site}.',
        ending: 'Si ce n\'était pas vous, réinitialisez votre mot de passe et vérifiez votre compte sans attendre.',
      },
      'passkey-removed': {
        subject: 'Clé d\'accès supprimée sur {site}',
        lead: 'La clé d\'accès nommée {detail} ne permet plus de se connecter à votre compte {site}.',
        ending: 'Si ce n\'était pas vous, réinitialisez votre mot de passe et vérifiez votre compte sans attendre.',
      },
      'token-created': {
        subject: 'Nouveau jeton d\'accès sur {site}',
        lead: 'Un jeton d\'accès nommé {detail} a été créé pour votre compte {site}.',
        ending: 'Si ce n\'était pas vous, réinitialisez votre mot de passe et vérifiez votre compte sans attendre.',
      },
      'signed-out-everywhere': {
        subject: 'Déconnexion partout sur {site}',
        lead: 'Votre compte {site} a été déconnecté partout : toutes ses sessions et tous ses jetons d\'accès ont pris fin.',
        ending: 'Si ce n\'était pas vous, réinitialisez votre mot de passe et vérifiez votre compte sans attendre.',
      },
      'account-deleted': {
        subject: 'Compte supprimé sur {site}',
        lead: 'Votre compte {site} a été supprimé.',
        ending: 'Si ce n\'était pas vous, contactez le site sans attendre.',
      },
    },
  },
})
