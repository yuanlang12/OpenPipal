# Security Policy

OpenPipal is a small open-source project maintained in the open. This page says how to
report a vulnerability privately and what to expect. The security model itself is described
in [docs/security/security-model.md](docs/security/security-model.md) and
[the local HTTP boundary](docs/security/local-http-boundary.md).

## Report a vulnerability privately

Use GitHub's private vulnerability reporting flow:

1. Open the repository on GitHub and select its **Security** tab.
2. Select **Report a vulnerability** under private vulnerability reporting.
3. Submit the report without opening a public issue or discussion.

If GitHub does not show that option, use a private contact channel published on the
repository owner's verified GitHub profile. This repository does not publish a security
email address; do not guess one. Keep the report private until a route is available, and do
not include secrets, personal data, or an active exploit in a public request for contact.

Include, when available:

- the affected version, commit, component, and Runtime mode;
- a concise impact statement and the conditions required to reproduce it;
- minimal reproduction steps using synthetic data in an isolated environment;
- sanitized logs or screenshots with tokens, paths, prompts, and user data
  removed;
- suggested mitigations or fixes, if known.

## Testing boundaries

Only test systems, accounts, data, and devices that you own or are explicitly
authorized to test. Do not access another user's OpenPipal data, provider account,
browser profile, or local services. Avoid destructive proofs of concept when a
non-destructive reproduction demonstrates the issue.

The maintainers coordinate validation and disclosure through the private GitHub report.
Reports are acknowledged, but this is a volunteer-maintained project and no fixed
remediation deadline is promised.

## What belongs elsewhere

General bugs, feature requests, and documentation corrections are not security reports.
Use [Issues](https://github.com/yuanlang12/OpenPipal/issues) when the report contains no
sensitive information.
