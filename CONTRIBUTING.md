# Contributing

## Development

```bash
npm install
npm run dev      # runs `convex dev` against the example app + watches/builds src
```

## Before opening a PR

```bash
npm run build      # type-checks + emits dist/
npm run test       # vitest (convex-test, edge-runtime)
npm run typecheck  # tsc for src + example
npm run lint       # eslint
```

The component lives in `src/component/` (the sandboxed backend) and `src/client/`
(the `Sweego` class apps import). `example/` is a runnable Convex app used as the
integration test bed.
