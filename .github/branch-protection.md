# Branch Protection: `main`

These rules must be applied manually by Shubham in GitHub repository
Settings > Branches > Branch protection rules. The tool API requires an
admin token, so they are documented here rather than configured in code.

## Rule target

- Branch name pattern: `main`

## Required settings

- [ ] Require a pull request before merging
  - [ ] Require at least 1 approval (self-approval permitted for solo work)
- [ ] Require status checks to pass before merging
  - [ ] Require branches to be up to date before merging
  - Required checks:
    - [ ] `typecheck`
    - [ ] `lint`
    - [ ] `format-check`
- [ ] Do not allow force pushes
- [ ] Do not allow deletions
- [ ] Direct pushes to `main` are blocked (enforced by the above)

## Notes

- Status check names must match the CI job names in
  `.github/workflows/ci.yml` exactly: `typecheck`, `lint`, `format-check`.
- Status checks only appear in the settings list after the CI workflow
  has run at least once on a pull request.
