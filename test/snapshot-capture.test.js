import test from "node:test";
import assert from "node:assert/strict";
import { createSnapshotCapture } from "../src/snapshot-capture.js";

const scope = { clusterId: "cluster-1", gridId: "grid-a", serverId: "server-1" };
const capturedAt = "2026-11-14T12:00:00.000Z";

function createHarness(overrides = {}) {
  const calls = { source: 0, sink: 0 };
  const source = {
    async capture(request) {
      calls.source += 1;
      return {
        ownerId: "player-7",
        assetId: request.assetId,
        scope: request.scope,
        state: { inventory: [{ itemId: "item-1", quantity: 3 }], metadata: { quality: 1 } }
      };
    },
    ...overrides.source
  };
  const sink = {
    async persist(snapshot) {
      calls.sink += 1;
      return { snapshotId: snapshot.snapshotId, durable: true, receipt: "store-receipt-1" };
    },
    ...overrides.sink
  };
  const service = createSnapshotCapture({
    source,
    sink,
    createSnapshotId: overrides.createSnapshotId ?? (() => "snapshot-1"),
    clock: overrides.clock ?? (() => capturedAt),
    maxStateBytes: overrides.maxStateBytes
  });
  return { service, calls };
}

for (const kind of ["inventory", "tame", "ship"]) {
  test(`captures and durably persists a ${kind} snapshot through injected adapters`, async () => {
    const { service, calls } = createHarness();
    const result = await service.capture({ kind, assetId: `${kind}-42`, scope, reason: "pre-loss-checkpoint" });
    assert.equal(result.snapshot.kind, kind);
    assert.equal(result.snapshot.ownerId, "player-7");
    assert.equal(result.snapshot.snapshotId, "snapshot-1");
    assert.equal(result.persistence.durable, true);
    assert.equal(calls.source, 1);
    assert.equal(calls.sink, 1);
  });
}

test("detaches and deeply freezes captured provider state", async () => {
  const providerState = { nested: { items: ["one"] } };
  const { service } = createHarness({
    source: {
      async capture(request) {
        return { ownerId: "player-7", assetId: request.assetId, scope: request.scope, state: providerState };
      }
    }
  });
  const result = await service.capture({ kind: "inventory", assetId: "player-7", scope });
  providerState.nested.items.push("later");
  assert.deepEqual(result.snapshot.state.nested.items, ["one"]);
  assert.equal(Object.isFrozen(result.snapshot.state.nested), true);
  assert.equal(Object.isFrozen(result.snapshot.state.nested.items), true);
});

test("coalesces concurrent capture requests for the same scoped asset", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { service, calls } = createHarness({
    source: {
      async capture(request) {
        calls.source += 1;
        await gate;
        return { ownerId: "player-7", assetId: request.assetId, scope: request.scope, state: { items: [] } };
      }
    }
  });
  const first = service.capture({ kind: "ship", assetId: "ship-1", scope });
  const second = service.capture({ kind: "ship", assetId: "ship-1", scope });
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a, b);
  assert.equal(calls.source, 1);
  assert.equal(calls.sink, 1);
});

test("does not coalesce different grids or asset types", async () => {
  const { service, calls } = createHarness();
  await Promise.all([
    service.capture({ kind: "ship", assetId: "same-id", scope }),
    service.capture({ kind: "tame", assetId: "same-id", scope }),
    service.capture({ kind: "ship", assetId: "same-id", scope: { ...scope, gridId: "grid-b" } })
  ]);
  assert.equal(calls.source, 3);
  assert.equal(calls.sink, 3);
});

test("rejects source identity or scope mismatch before persistence", async () => {
  const { service, calls } = createHarness({
    source: {
      async capture(request) {
        return { ownerId: "player-7", assetId: "different-asset", scope: request.scope, state: {} };
      }
    }
  });
  await assert.rejects(service.capture({ kind: "ship", assetId: "ship-1", scope }), /different assetId/);
  assert.equal(calls.sink, 0);
});

test("rejects invalid or non-JSON snapshot state", async () => {
  for (const state of [{ nested: undefined }, { amount: Number.NaN }, { date: new Date() }]) {
    const { service, calls } = createHarness({
      source: {
        async capture(request) {
          return { ownerId: "player-7", assetId: request.assetId, scope: request.scope, state };
        }
      }
    });
    await assert.rejects(service.capture({ kind: "inventory", assetId: "player-7", scope }));
    assert.equal(calls.sink, 0);
  }
});

test("enforces a bounded snapshot size", async () => {
  const { service, calls } = createHarness({
    maxStateBytes: 8,
    source: {
      async capture(request) {
        return { ownerId: "player-7", assetId: request.assetId, scope: request.scope, state: { text: "too long" } };
      }
    }
  });
  await assert.rejects(service.capture({ kind: "inventory", assetId: "player-7", scope }), /maxStateBytes/);
  assert.equal(calls.sink, 0);
});

test("requires a durable persistence receipt before returning success", async () => {
  const { service } = createHarness({
    sink: { async persist(snapshot) { return { snapshotId: snapshot.snapshotId, durable: false, receipt: "not-durable" }; } }
  });
  await assert.rejects(service.capture({ kind: "tame", assetId: "tame-1", scope }), /invalid persistence receipt/);
});

test("rejects invalid capture timestamps before reading source", async () => {
  const { service, calls } = createHarness({ clock: () => "2026-02-30T12:00:00.000Z" });
  await assert.rejects(service.capture({ kind: "ship", assetId: "ship-1", scope }), /valid calendar date/);
  assert.equal(calls.source, 0);
});

test("rejects unknown recovery kinds", async () => {
  const { service } = createHarness();
  await assert.rejects(service.capture({ kind: "character", assetId: "char-1", scope }), /kind must be/);
});

for (const completedAt of ["2026-11-14T12:01:00.000Z", "2026-11-14T12:02:00.000Z"]) {
  test(`a delayed read completed at ${completedAt} cannot become pre-loss evidence`, async () => {
    const { createRecoveryCase, evaluateRecoveryEvidence } = await import("../src/recovery.js");
    let now = capturedAt;
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const { service } = createHarness({
      clock: () => now,
      source: { async capture(request) {
        await gate;
        return { ownerId: "player-7", assetId: request.assetId, scope: request.scope, state: { lost: true } };
      } }
    });
    const pending = service.capture({ kind: "ship", assetId: "ship-1", scope });
    now = completedAt;
    release();
    const { snapshot } = await pending;
    assert.equal(snapshot.capturedAt, completedAt);
    const recoveryCase = createRecoveryCase({
      caseId: "case-1", kind: "ship", requesterId: "player-7", ownerId: "player-7",
      assetId: "ship-1", snapshotId: snapshot.snapshotId, lossEventId: "loss-1", scope,
      requestedAt: "2026-11-14T12:03:00.000Z"
    });
    const evidence = evaluateRecoveryEvidence(recoveryCase, snapshot, {
      eventId: "loss-1", eventType: "ship.sunk", assetId: "ship-1", ownerId: "player-7", scope,
      occurredAt: "2026-11-14T12:01:00.000Z"
    });
    assert.equal(evidence.eligible, false);
    assert.deepEqual(evidence.reasons, ["snapshot_after_loss"]);
  });
}

for (const completionTime of ["2026-02-30T12:00:00.000Z", "2026-11-14T11:59:59.999Z"]) {
  test(`rejects invalid or reversed completion clock: ${completionTime}`, async () => {
    let reads = 0;
    const { service, calls } = createHarness({ clock: () => reads++ === 0 ? capturedAt : completionTime });
    await assert.rejects(service.capture({ kind: "ship", assetId: "ship-1", scope }), /calendar date|backwards/);
    assert.equal(calls.source, 1);
    assert.equal(calls.sink, 0);
  });
}

for (const state of [
  {}, { text: 'é😀\n"\\\ud800' }, { nested: [null, true, false, -0, 1e30, {}] },
  { first: 1, second: { value: "two" } }
]) {
  test(`enforces exact serialized byte boundary: ${JSON.stringify(state)}`, async () => {
    const bytes = new TextEncoder().encode(JSON.stringify(state)).byteLength;
    for (const maxStateBytes of [bytes - 1, bytes]) {
      const { service, calls } = createHarness({
        maxStateBytes,
        source: { async capture(request) {
          return { ownerId: "player-7", assetId: request.assetId, scope: request.scope, state };
        } }
      });
      const pending = service.capture({ kind: "ship", assetId: "ship-1", scope });
      if (maxStateBytes < bytes) {
        await assert.rejects(pending, /maxStateBytes/);
        assert.equal(calls.sink, 0);
      } else {
        assert.equal((await pending).snapshot.stateBytes, bytes);
      }
    }
  });
}

test("stops validation before traversing state beyond the byte budget", async () => {
  let visited = false;
  const state = { text: "x".repeat(1024) };
  Object.defineProperty(state, "later", { enumerable: true, get() { visited = true; throw new Error("should not read"); } });
  const { service, calls } = createHarness({
    maxStateBytes: 16,
    source: { async capture(request) {
      return { ownerId: "player-7", assetId: request.assetId, scope: request.scope, state };
    } }
  });
  await assert.rejects(service.capture({ kind: "ship", assetId: "ship-1", scope }), /maxStateBytes/);
  assert.equal(visited, false);
  assert.equal(calls.sink, 0);
});
