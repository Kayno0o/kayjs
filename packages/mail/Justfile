lint-actions:
	actionlint -config-file actionlint.yaml .forgejo/workflows/*.yml

patch: # v0.0.X
	bun pm version patch
	git push
	git push --tags

minor: # v0.X.0
	bun pm version minor
	git push
	git push --tags

major: # vX.0.0
	bun pm version major
	git push
	git push --tags
