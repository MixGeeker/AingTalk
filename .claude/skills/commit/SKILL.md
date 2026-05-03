## 提交当前内容

1. Run `pnpm typecheck` and ensure it passes
2. Run `pnpm test` and ensure all tests pass
3. Run `git status` to check for merge conflicts or unmerged paths
4. If conflicts exist: investigate conflict points, report details to the user, and ask how to resolve before proceeding
5. If no conflicts: stage all changed files with `git add -A`
6. Generate a concise conventional-commit message based on the diff
7. Commit and push

Do not ask for confirmation on non-conflict steps — just do them.
When conflicts are found, always pause and ask the user before taking any action.
