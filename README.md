# CMG Player

Player utilities and progression operations for the ATLAS cluster, including recovery of lost player inventories, tames, and ships.

This plugin extends [Chaotic Minds Gaming Core](https://github.com/Chaotic-Minds-Collective/cmg-atlas-core-plugin) and the [ATLAS integration adapter](https://github.com/Chaotic-Minds-Collective/cmg-atlas-plugin). It does not replace either foundation.

## Recovery

The initial recovery foundation validates pre-loss snapshots against normalized loss events, asset ownership, and cluster/grid/server scope. It requires explicit approval and a provider operation receipt before a claim can be marked restored.

See [docs/RECOVERY.md](docs/RECOVERY.md) for the evidence contract, workflow, and live-server verification gates.

## Readiness

Recovery policy tests run with Node.js 22 or later:

```sh
npm test
npm run check
```

Native ATLAS compatibility, snapshot callbacks, and provider restore operations remain unverified. No production deployment or live-server action is implied.
