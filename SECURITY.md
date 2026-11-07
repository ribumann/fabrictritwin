# Security policy

## Reporting a vulnerability

Please do not report exploitable vulnerabilities in public issues or pull
requests. If GitHub's private vulnerability reporting is enabled for this
repository, use that channel. If it is unavailable, contact a repository
maintainer privately through GitHub before disclosing details publicly.

Include only the information needed to reproduce and assess the issue. Do not
send real credentials, access tokens, SAS strings, personal data, tenant or
principal identifiers, or private deployment output. There is no published
response-time or bounty commitment.

## Deployment safety

The repository includes scripts and infrastructure templates that can create,
modify, or delete cloud resources. Review the
[dependency and configuration inventory](docs/dependencies-and-configuration.md)
and verify the exact tenant, subscription, resource group, identities, and
targets before using them. Do not enable quarantined workflows or run destructive
operations without a separate review and explicit authorization.
