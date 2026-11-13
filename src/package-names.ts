// kay and its libraries were published under the `@kaynooo` scope up to 1.103 and are under `@kayjs` since 1.104: the new name of each, which `kay upgrade` and the `deprecated-package-names` lint move an app to.
export const RENAMED_PACKAGES: Readonly<Record<string, string>> = {
  '@kaynooo/kayjs': '@kayjs/kay',
  '@kaynooo/kayjs-ai': '@kayjs/ai',
  '@kaynooo/kayjs-auth': '@kayjs/auth',
  '@kaynooo/kayjs-cms': '@kayjs/cms',
  '@kaynooo/kayjs-mail': '@kayjs/mail',
  '@kaynooo/kayjs-ui': '@kayjs/ui',
}

// An old name in a manifest, an import or a config key, whole: not a longer name, `@kaynooo/kayjs-ui` being matched in `@kaynooo/kayjs-ui/button.kay` but `@kaynooo/kayjs-uikit` not at all.
export const OLD_PACKAGE_NAME = /@kaynooo\/kayjs(?:-(?:ai|auth|cms|mail|ui))?(?![\w-])/g

// `text` with every old package name written as its new one.
export function renamePackages(text: string): string {
  return text.replace(OLD_PACKAGE_NAME, name => RENAMED_PACKAGES[name]!)
}

// Whether a registry name is kay or one of its libraries under the scope they are published under now.
export function isKayPackage(name: string): boolean {
  return Object.values(RENAMED_PACKAGES).includes(name)
}

// The first version published under the new names: the kay and libraries an upgrade installs before it are the old ones.
export const RENAMED_IN = '1.104.0'
