# Security Policy

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use [GitHub private vulnerability reporting](https://github.com/AgentsKit-io/code-review-cli/security/advisories/new) with the affected version, impact, reproduction steps, and any suggested mitigation.

Please do not include secrets or private source code beyond what is necessary to reproduce the issue. We will acknowledge a complete report, investigate it, and coordinate disclosure and remediation with the reporter.

## Scope reminders

This tool sends selected code to the provider you configure. Review that provider's data handling policy before using a hosted API. Prefer a local model or approved private gateway for repositories whose policy prohibits external processing. Store GitHub tokens and provider keys as secrets; never commit them to workflow files.
