lint-actions:
	actionlint -config-file actionlint.yaml .forgejo/workflows/*.yml

patch: # v0.0.X
	bun pm version patch
	git push --follow-tags

minor: # v0.X.0
	bun pm version minor
	git push --follow-tags

major: # vX.0.0
	bun pm version major
	git push --follow-tags
