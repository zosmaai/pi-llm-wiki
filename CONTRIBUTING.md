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
