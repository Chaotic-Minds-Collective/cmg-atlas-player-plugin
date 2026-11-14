# CMG Player

Player utilities and progression operations for the ATLAS cluster, including recovery of lost player inventories, tames, and ships.

This plugin extends [Chaotic Minds Gaming Core](https://github.com/Chaotic-Minds-Collective/cmg-atlas-core-plugin) and the [ATLAS integration adapter](https://github.com/Chaotic-Minds-Collective/cmg-atlas-plugin). It does not replace either foundation.

## Recovery

- [Recovery policy](docs/RECOVERY.md) validates pre-loss snapshots against normalized loss events, identity, ownership, and cluster/grid/server scope.
- [Snapshot capture contract](docs/SNAPSHOT_CAPTURE.md) defines bounded, immutable capture through injected server-source and durable-storage adapters.

These modules are server-independent foundations. Native ATLAS callbacks, asset-state sources, persistent storage integration, and provider restore operations remain unverified. No production deployment or live-server action is implied.

## Readiness

Recovery tests run with Node.js 22 or later:

```sh
npm test
npm run check
```
