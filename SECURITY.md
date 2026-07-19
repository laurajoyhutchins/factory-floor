# Security policy

## Supported versions

Factory Floor is under active development. Security fixes are applied to the current default branch and, when practical, to the latest published release. Older snapshots are not guaranteed to receive fixes.

## Report a vulnerability privately

Do not disclose suspected vulnerabilities, exposed credentials, private data, or exploit details in a public issue, pull request, discussion, commit, workflow log, or artifact.

Use GitHub's private vulnerability reporting flow for this repository:

1. Open the repository's **Security** tab.
2. Select **Advisories**.
3. Select **Report a vulnerability**.

If that control is unavailable, open a minimal issue stating only that you need a private security contact channel. Do not include technical details or sensitive values in that issue.

## What to include

Provide enough information to reproduce and assess the problem without including unrelated private data:

- affected revision, release, component, and deployment assumptions;
- a minimal reproduction or proof of concept;
- the expected and observed authority boundary;
- impact, required privileges, and whether exploitation is repeatable;
- evidence that credentials or personal data may have been exposed, with secret values redacted.

## Credential exposure

Treat any committed, logged, or uploaded real credential as compromised. Revoke or rotate it before attempting history rewriting, log removal, or artifact deletion. Never paste the value into a GitHub issue or pull request while coordinating remediation.

## Disclosure and remediation

Please allow time for validation and remediation before public disclosure. The project will coordinate disclosure through the private advisory when possible, but does not promise a fixed response or release timeline.
