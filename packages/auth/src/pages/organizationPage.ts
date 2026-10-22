import type { AuthFeatures } from './index'
import { localize } from 'kay/i18n'

// The page of one organization, named by its slug when it has one, in the request's locale.
export function organizationPage(features: Pick<AuthFeatures, 'pages' | 'prefix'>, organization: { id: string, slug: string | null }): string {
  return localize(`${features.pages?.prefix ?? features.prefix}/account/organizations/${encodeURIComponent(organization.slug ?? organization.id)}`)
}

// The page listing the organizations, in the request's locale.
export function organizationsPage(features: Pick<AuthFeatures, 'pages' | 'prefix'>): string {
  return localize(`${features.pages?.prefix ?? features.prefix}/account/organizations`)
}
