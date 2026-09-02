# Security policy

Noxroot is an experimental MVP. Do not report a suspected vulnerability in a public issue if the
report includes exploit details, repository data, credentials, or personal data. Contact the
repository owner through GitHub's private vulnerability reporting feature when it is enabled. If
private reporting is unavailable, open a minimal public issue asking for a private contact channel
without including sensitive details.

Supported security fixes currently target the latest `0.1.x` source. Preview writes, child
execution, network attempts, secret disclosure, path traversal/symlink escape, verification
self-authorization, and dirty-work loss are treated as release-blocking defects.
