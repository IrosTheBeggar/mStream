# Release Instructions

Getting github actions to properly work requires a specific set of steps

- Bump the version number of package.json.  Make a commit with the message "vX.X.X"
- Tag the commit `git tag vX.X.X`
- run `git push && git push --tags`