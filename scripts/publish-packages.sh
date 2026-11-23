#!/bin/sh
# Publishes every non-private package under packages/* to the given registry:
#   scripts/publish-packages.sh <registry url>
# Prerelease versions (-alpha, -beta, -rc) are published under their matching
# dist-tag so the stable `latest` tag (e.g. Kay v1) is never overwritten.
# Versions already present on the registry are skipped so reruns are idempotent.
set -eu

registry="$1"

wrong=$(cat .npmrc packages/*/.npmrc 2>/dev/null | grep '^@kayjs:registry=' | grep -vxF "@kayjs:registry=$registry" || true)
if [ -n "$wrong" ]; then
  echo "A project .npmrc sends @kayjs elsewhere than $registry: $wrong"
  exit 1
fi

for manifest in packages/*/package.json; do
  configured=$(jq -r '.publishConfig.registry // empty' "$manifest")
  if [ -n "$configured" ] && [ "$configured" != "$registry" ]; then
    echo "$manifest publishes to $configured, not $registry"
    exit 1
  fi
done

publish() {
  name="$(jq -r '.name' package.json)"
  version="$(jq -r '.version' package.json)"
  package="${name}@${version}"
  tag=""
  case "$version" in
    *-alpha*) tag="alpha" ;;
    *-beta*) tag="beta" ;;
    *-rc*) tag="rc" ;;
  esac

  if bun pm view "$package" version > /dev/null 2>&1; then
    echo "$package is already published"
  elif [ -n "$tag" ]; then
    echo "Publishing $package with dist-tag $tag..."
    bun publish --access public --tag "$tag"
  else
    echo "Publishing $package..."
    bun publish --access public
  fi
}

for dir in packages/*/; do
  [ "$(jq -r '.private // false' "$dir/package.json")" = true ] || (cd "$dir" && publish) || exit 1
done
