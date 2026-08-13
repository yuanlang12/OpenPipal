# Security Policy

OpenPipal is still preparing its source for possible public release. The current
security review is frozen and has not been sealed, so this policy must not be
read as a claim that the repository is release-ready.

## Report a vulnerability privately

Use GitHub's private vulnerability reporting flow:

1. Open the repository on GitHub and select its **Security** tab.
2. Select **Report a vulnerability** under private vulnerability reporting.
3. Submit the report without opening a public issue or discussion.

If GitHub does not show that option, use a private contact channel published on
the repository owner or maintainer's verified GitHub profile. This repository
does not publish a security email address yet; do not guess one. If neither a
GitHub private report nor a verified private maintainer channel is available,
the repository does not currently have a safe reporting route. Keep the report
private until the maintainers enable one; do not include secrets, personal data,
or an active exploit in a public request for contact.

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

The maintainers will coordinate validation and disclosure through the private
GitHub report. No response or remediation deadline is promised while the public
release and support policy remain undecided.

## What belongs elsewhere

General bugs, feature requests, and documentation corrections are not security
reports. Use the repository issue workflow when it is publicly enabled and the
report contains no sensitive information.

For implementation-level security architecture, see
[docs/SECURITY.md](docs/SECURITY.md) and
[the local HTTP boundary](docs/security/local-http-boundary.md).
