# Contributing

Thanks for helping improve YoMobiles.

## Before You Change Code

- Read [`README.md`](README.md) and [`.env.example`](.env.example).
- Keep authentication, API contracts, and database behavior stable unless a change is explicitly requested.
- Do not commit secrets, tokens, or local environment files.

## Recommended Workflow

1. Create a feature branch.
2. Make the smallest change that solves the problem.
3. Add or update tests when behavior changes.
4. Run:
   - `npm test`
5. Update documentation when the public API or setup changes.

## Pull Requests

- Explain what changed and why.
- Link the issue or task if one exists.
- Call out any migration or environment changes.

## Style

- Prefer small, focused commits.
- Keep route handlers, auth helpers, and model logic consistent with the current structure.
