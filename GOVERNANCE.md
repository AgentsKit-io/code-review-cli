# Governance

AgentsKit Code Review is maintained in public by the AgentsKit organization.
Emerson Braun is the primary maintainer. Repository maintainers are responsible
for triage, reviews, releases, security response, and enforcing the contribution
and conduct policies.

## Decisions

Bug reports, feature proposals, and implementation decisions belong in public
issues and pull requests whenever they do not involve a vulnerability or private
data. Maintainers decide by documented technical merit, compatibility with the
project roadmap, provider neutrality, maintenance cost, and evidence from tests
or reproducible examples.

Small, focused changes may proceed directly through a pull request. Contributors
should open an issue before a large architectural change. Maintainers have final
merge authority and may decline changes that expand scope without sufficient
evidence or a sustainable maintenance path.

Security reports follow [SECURITY.md](SECURITY.md) and remain private until
coordinated disclosure is appropriate. Conduct matters follow
[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## Releases

Releases are cut from `main` after the required repository checks pass. A
maintainer updates the version and changelog, verifies the npm package contents,
creates the corresponding Git tag and GitHub release, and publishes through the
repository's approved release credentials. Release notes link the shipped
changes to public history.

Maintainer or release-process changes are documented in this file through the
same pull request workflow.
