# Security Policy

## Supported Versions

The current backend branch is the supported line for active YoMobiles work.

## Reporting a Vulnerability

Do not open a public issue for sensitive security problems.

Instead:

- use GitHub Security Advisories if available for the repository, or
- contact the repository maintainer directly through the project's private communication channel

Please include:

- a short description of the issue
- the affected endpoint or code path
- the observed impact
- reproduction steps if available

## Handling Secrets

- Never commit JWT secrets, database passwords, API keys, or private signing material.
- Use environment variables and local `.env` files that remain untracked.
