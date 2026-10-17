import { defineMessages } from 'kay/i18n'

export default defineMessages({
  title: 'Mots',
  kay: {
    invalid: { required: 'Champ requis', tooShort: 'Au moins {min} caractères', tooLong: 'Au plus {max} caractères', tooSmall: '{min} ou plus' },
    action: { serverError: 'Une erreur est survenue de notre côté', invalidFile: 'Type de fichier invalide', bodyLimit: 'Trop volumineux, {size} au plus' },
    protection: { honeypot: 'Laissez ce champ vide', minTime: { early: 'Envoyé trop vite' }, rateLimit: 'Trop d\'essais, réessayez dans {seconds} s' },
  },
})
