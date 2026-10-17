import { defineMessages } from 'kay/i18n'

export default defineMessages({
  title: 'Mots',
  kay: {
    invalid: { required: 'Champ requis', tooShort: 'Au moins {min} caractères', tooLong: 'Au plus {max} caractères', tooSmall: '{min} ou plus', format: 'Pas au format {format}', tooFewItems: 'Au moins {min} choix', tooManyItems: 'Au plus {max} choix' },
    offline: { title: 'Hors ligne', text: 'Cette page demande une connexion, et aucune n\'est ouverte.' },
    action: { serverError: 'Une erreur est survenue de notre côté', invalidFile: 'Type de fichier invalide', bodyLimit: 'Trop volumineux, {size} au plus' },
    protection: { honeypot: 'Laissez ce champ vide', minTime: { early: 'Envoyé trop vite' }, rateLimit: 'Trop d\'essais, réessayez dans {seconds} s' },
  },
})
