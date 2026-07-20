# Refresh a pull request lockfile

For an open same-repository pull request owned by this repository, add a top-level comment containing exactly:

```text
/refresh-lockfile
```

The default-branch workflow validates that the command came from the repository owner, checks out the pull request's exact head, runs pnpm 10.12.1 with lifecycle scripts disabled, rejects any change outside `pnpm-lock.yaml`, and pushes a normal non-forced commit to the pull request branch.

Fork pull requests, closed pull requests, non-owner commands, unexpected working-tree changes, and non-fast-forward updates fail closed.
