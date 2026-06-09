# Contributing

## Local Setup

```bash
git clone https://github.com/zosmaai/pi-llm-wiki.git
cd pi-llm-wiki
npm install
pi install ./
```

## Development

```bash
npm run test           # run tests
npm run test:coverage  # run tests with coverage report
npm run typecheck      # TypeScript type check
npm run lint           # biome lint check
npm run lint:fix       # auto-fix lint issues
```

## Pull Request Hygiene

When writing a PR description for a bug fix, separate **"actual bug"** from
**"defensive cleanup"** so reviewers can audit each claim independently.

Reviewers should be able to mentally substitute pre-fix code into each claim
and verify that the symptom would still reproduce. If a claim describes a
reordering or guard-addition that wouldn't have changed observable behavior
on its own (for example, a flag with a permissive default like
`noticesEnabled({}) === true`), call it out as **defensive hygiene** rather
than part of the root cause.

A template for the body:

- **Problem** — the observable symptom, ideally with reproduction steps.
- **Root cause** — the *one* change that, if reverted, would bring the bug
  back. Be precise: which line, which missing guard, which order issue,
  which off-by-one.
- **Defensive cleanup (optional)** — any other changes in the same PR that
  harden the code but were not strictly necessary to fix the symptom. These
  belong in their own section so they don't get confused with the root cause.

When in doubt, also add a **regression test** that fails against the
pre-fix code — it's the single most reliable way to prove the diagnosis was
correct and to keep the bug from coming back.

## Release Process

```bash
npm run release:patch  # bump patch version
npm run release:minor  # bump minor version
npm run release:major  # bump major version
npm run release:push   # push to origin with tags
```

The release script:

1. Verifies clean git tree and `main` branch
2. Runs typecheck, lint, and tests
3. Bumps version in `package.json`
4. Updates `CHANGELOG.md`
5. Commits and tags

CI handles npm publish on tag push.

## License

MIT
