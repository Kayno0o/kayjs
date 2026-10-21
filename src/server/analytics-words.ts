export interface Words { text: string, agree: string, refuse: string, policy: string }

// The notice (`consent`) and the information line (`info`) as kay words them, English and French: the script reads the page's `lang` and falls back to English, and an app's own strings win over both.
export const SHIPPED_WORDS: Record<'consent' | 'info', Record<string, Words>> = {
  consent: {
    en: { text: 'We count visits to improve this site with {provider}, without cookies that follow you. Do you agree?', agree: 'Agree', refuse: 'Refuse', policy: 'Privacy\u00A0policy' },
    fr: { text: 'Nous comptons les visites pour améliorer ce site avec {provider}, sans cookie qui vous suit. Êtes-vous d\'accord\u00A0?', agree: 'Accepter', refuse: 'Refuser', policy: 'Politique\u00A0de\u00A0confidentialité' },
  },
  info: {
    en: { text: 'We count visits to improve this site with {provider}, without cookies that follow you. You can opt out.', agree: 'OK', refuse: 'Opt\u00A0out', policy: 'Privacy\u00A0policy' },
    fr: { text: 'Nous comptons les visites pour améliorer ce site avec {provider}, sans cookie qui vous suit. Vous pouvez vous y opposer.', agree: 'OK', refuse: 'Refuser', policy: 'Politique\u00A0de\u00A0confidentialité' },
  },
}
