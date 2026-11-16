# Snapshot Capture Contract

## Status

This is a server-independent capture coordinator. It does not prove that native ATLAS callbacks, inventory APIs, tame APIs, ship APIs, or a durable storage service are available.

## Adapter boundary

The capture coordinator accepts two injected adapters:

- `source.capture({ kind, assetId, scope })` obtains an authoritative point-in-time state from a verified server-side integration.
- `sink.persist(snapshot)` stores the snapshot durably and returns `{ snapshotId, durable: true, receipt }`.

<!-- coderabbit-ai-generated:v1 -->

<!-- coderabbit-ai-generated-section:v1:81e7385cca07751efba04d601081bf2a1415c89cfcb77dd510006e5fb80809c1 -->

The source must return `{ ownerId, assetId, scope, state }`. The returned asset ID and complete cluster/grid/server scope must exactly match the request. Owner identity is captured from the source, not accepted from the requesting player.

`capturedAt` is sampled after the source resolves and its state is detached and validated, before persistence. It is a conservative completion timestamp, not the request start or an adapter-provided observation time. A read spanning a loss must therefore fail the strictly pre-loss recovery check. The clock is also validated before reading the source; invalid completion timestamps and clocks moving backwards during capture are rejected before persistence. Integrations must use a trusted clock synchronized with loss-event timestamps and ensure it does not move backwards; this coordinator cannot establish ordering across unsynchronized server clocks.

<!-- /coderabbit-ai-generated:v1 -->

Supported kinds are `inventory`, `tame`, and `ship`. The opaque `state` must be a plain JSON object. It is detached and deeply frozen before persistence. Non-JSON values, cycles, sparse arrays, excessive depth/node count, and oversized state are rejected. The default state limit is 1 MiB; callers may choose a lower limit or a bounded limit up to 1 MiB.

## Invocation and idempotency

Capture is explicitly invoked by the caller. There is no built-in polling timer, background task, game callback, or automatic capture policy. Concurrent calls for the same kind, asset, and scope share one in-flight operation. Different asset types or grids remain independent.

A successful result requires a durable persistence receipt that matches the generated snapshot ID. A failed or uncertain persistence operation is not reported as success. The storage adapter must enforce its own durable uniqueness and retention rules; the in-memory in-flight guard is not a persistence-level deduplication guarantee.

## Integration requirements

Before connecting a native source adapter:

1. Verify the exact ATLAS server build, loader, SDK, and callback lifecycle on an isolated server.
2. Identify authoritative inventory, tame, and ship state sources; do not infer full state from death/sinking events.
3. Confirm owner and tribe identity, provider asset IDs, and cluster/grid/server scope.
4. Establish bounded payload size, capture cadence, retention, access controls, and encryption at rest.
5. Prove that snapshots are captured before loss events and can be read back intact.

The existing mock event stream is a test fixture, not proof of native callback support. A loss event alone cannot reconstruct inventory, tames, or ships.
