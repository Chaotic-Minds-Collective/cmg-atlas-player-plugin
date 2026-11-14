# CMG Player

Player utilities and progression operations for the ATLAS cluster, including recovery of lost player inventories, tames, and ships.

This plugin extends [Chaotic Minds Gaming Core](https://github.com/Chaotic-Minds-Collective/cmg-atlas-core-plugin) and the [ATLAS integration adapter](https://github.com/Chaotic-Minds-Collective/cmg-atlas-plugin). It does not replace either foundation.

## Recovery

- [Recovery policy](docs/RECOVERY.md) validates pre-loss snapshots against normalized loss events, identity, ownership, and cluster/grid/server scope.
- [Snapshot capture contract](docs/SNAPSHOT_CAPTURE.md) defines bounded, immutable capture through injected server-source and durable-storage adapters.
- [Core snapshot sink](docs/CORE_SNAPSHOT_SINK.md) maps bounded snapshots to Core's server-scoped persistence API.
- [Core snapshot reader](docs/CORE_SNAPSHOT_READER.md) provides explicitly invoked, read-only listing and retrieval of persisted snapshot evidence.

The Core sink and reader require dedicated server-scoped service tokens. Neither schedules captures nor supplies a native ATLAS state source. The reader cannot restore or mutate game state.

Native ATLAS callbacks, asset-state sources, and provider restore operations remain unverified. No production deployment or live-server action is implied.

## Readiness

Recovery tests run with Node.js 22 or later:

```sh
npm test
npm run check
```
