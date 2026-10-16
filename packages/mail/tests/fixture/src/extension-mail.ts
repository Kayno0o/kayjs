import { mailer } from '../../../src/mailer'

// The mailer `mailExtension('./src/extension-mail')` names by path, with no `.kay` mail to import: this package's check has no shadow types for the fixture's.
export const mail = mailer({ from: 'Fixture <hello@fixture.test>' })
