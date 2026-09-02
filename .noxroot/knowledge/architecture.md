# Repository architecture

Status: confirmed from repository evidence during initialization.

- **Git repository** — .git
- **Node.js project** — package.json
- **TypeScript source** — tsconfig.json
- **Continuous integration** — .github/workflows/ci.yml

This is a routing map, not a substitute for source code. Application-agent frameworks, when present,
are application architecture: Noxroot does not own or persist their runtime sessions, state, memory,
or user data.
