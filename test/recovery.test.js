import test from "node:test";
import assert from "node:assert/strict";
import {
  completeRecoveryClaim,
  createRecoveryCase,
  createRecoveryClaim,
  evaluateRecoveryEvidence,
  recoveryLossEventTypes
} from "../src/recovery.js";

const scope = { clusterId: "cluster-1", gridId: "grid-a", serverId: "server-1" };

function fixtures(kind = "ship") {
  const lossEventType = recoveryLossEventTypes[kind][0];
  const assetId = `${kind}-42`;
  const ownerId = "player-7";
  const recoveryCase = createRecoveryCase({
    caseId: "case-1",
    kind,
    requesterId: "requester-7",
    ownerId,
    assetId,
    snapshotId: "snapshot-1",
    lossEventId: "event-1",
    scope,
    requestedAt: "2026-11-14T12:00:00.000Z"
  });
  const snapshot = {
    snapshotId: "snapshot-1",
    kind,
    assetId,
    ownerId,
    scope,
    capturedAt: "2026-11-14T11:00:00.000Z",
    state: { opaqueProviderState: true }
  };
  const lossEvent = {
    eventId: "event-1",
    eventType: lossEventType,
    assetId,
    ownerId,
    scope,
    occurredAt: "2026-11-14T11:30:00.000Z"
  };
  return { recoveryCase, snapshot, lossEvent };
}

test("declares the supported loss event for each recovery type", () => {
  assert.deepEqual(recoveryLossEventTypes, {
    inventory: ["player.died"],
    tame: ["tame.died"],
    ship: ["ship.sunk"]
  });
});

for (const kind of ["inventory", "tame", "ship"]) {
  test(`${kind} recovery evidence is eligible when identity, scope, and time match`, () => {
    const data = fixtures(kind);
    assert.deepEqual(evaluateRecoveryEvidence(...Object.values(data)), {
      caseId: "case-1",
      kind,
      requesterId: data.recoveryCase.requesterId,
      ownerId: data.recoveryCase.ownerId,
      assetId: data.recoveryCase.assetId,
      scope,
      requestedAt: data.recoveryCase.requestedAt,
      snapshotId: "snapshot-1",
      lossEventId: "event-1",
      eligible: true,
      reasons: []
    });
  });
}

test("rejects a snapshot captured after the loss", () => {
  const data = fixtures();
  data.snapshot.capturedAt = "2026-11-14T11:45:00.000Z";
  assert.ok(evaluateRecoveryEvidence(...Object.values(data)).reasons.includes("snapshot_after_loss"));
});

test("rejects owner, asset, and grid mismatches", () => {
  const data = fixtures("tame");
  data.snapshot.ownerId = "another-player";
  data.lossEvent.assetId = "different-tame";
  data.lossEvent.scope = { ...scope, gridId: "grid-b" };
  const result = evaluateRecoveryEvidence(...Object.values(data));
  assert.equal(result.eligible, false);
  assert.ok(result.reasons.includes("snapshot_owner_mismatch"));
  assert.ok(result.reasons.includes("loss_event_asset_mismatch"));
  assert.ok(result.reasons.includes("loss_event_scope_mismatch"));
});

test("rejects a death event as evidence of a sunk ship", () => {
  const data = fixtures("ship");
  data.lossEvent.eventType = "player.died";
  assert.ok(evaluateRecoveryEvidence(...Object.values(data)).reasons.includes("loss_event_type_unsupported"));
});

test("requires an explicit approval before creating a claim", () => {
  const data = fixtures();
  const evidence = evaluateRecoveryEvidence(...Object.values(data));
  assert.throws(() => createRecoveryClaim({ recoveryCase: data.recoveryCase, evidence }), /approval/);
});

test("creates a stable, scoped claim only after evidence and approval", () => {
  const data = fixtures();
  const evidence = evaluateRecoveryEvidence(...Object.values(data));
  const claim = createRecoveryClaim({
    recoveryCase: data.recoveryCase,
    evidence,
    approval: {
      caseId: data.recoveryCase.caseId,
      approvedBy: "admin-1",
      approvedAt: "2026-11-14T12:05:00.000Z"
    }
  });
  assert.equal(claim.status, "prepared");
  assert.equal(claim.idempotencyKey, "cmg-recovery:v1:4:ship:6:case-1");
  assert.equal(claim.scope.gridId, "grid-a");
});

test("does not allow evidence from a different case to authorize a claim", () => {
  const first = fixtures();
  const second = fixtures();
  const otherCase = createRecoveryCase({
    ...second.recoveryCase,
    caseId: "case-2"
  });
  const evidence = evaluateRecoveryEvidence(...Object.values(first));
  assert.throws(() => createRecoveryClaim({
    recoveryCase: otherCase,
    evidence,
    approval: { caseId: "case-2", approvedBy: "admin-1", approvedAt: "2026-11-14T12:05:00.000Z" }
  }), /does not belong/);
});

test("requires a matching case ID for approval", () => {
  const data = fixtures();
  const evidence = evaluateRecoveryEvidence(...Object.values(data));
  assert.throws(() => createRecoveryClaim({
    recoveryCase: data.recoveryCase,
    evidence,
    approval: { caseId: "other-case", approvedBy: "admin-1", approvedAt: "2026-11-14T12:05:00.000Z" }
  }), /does not match/);
});

test("requires a provider receipt to mark a claim restored", () => {
  const data = fixtures();
  const evidence = evaluateRecoveryEvidence(...Object.values(data));
  const claim = createRecoveryClaim({
    recoveryCase: data.recoveryCase,
    evidence,
    approval: { caseId: "case-1", approvedBy: "admin-1", approvedAt: "2026-11-14T12:05:00.000Z" }
  });
  const restored = completeRecoveryClaim(claim, "provider-operation-9");
  assert.equal(restored.status, "restored");
  assert.equal(completeRecoveryClaim(restored, "provider-operation-9"), restored);
  assert.throws(() => completeRecoveryClaim(restored, "different-operation"), /different provider receipt/);
});

for (const changes of [
  { kind: "tame" },
  { requesterId: "another-requester" },
  { ownerId: "another-owner" },
  { assetId: "another-asset" },
  ...["clusterId", "gridId", "serverId"].map(field => ({ scope: { ...scope, [field]: "other" } })),
  { requestedAt: "2026-11-14T12:01:00.000Z" }
]) {
  test(`rejects reused evidence when case fields change: ${JSON.stringify(changes)}`, () => {
    const data = fixtures();
    const evidence = evaluateRecoveryEvidence(...Object.values(data));
    const otherCase = createRecoveryCase({ ...data.recoveryCase, ...changes });
    assert.throws(() => createRecoveryClaim({
      recoveryCase: otherCase,
      evidence,
      approval: { caseId: "case-1", approvedBy: "admin-1", approvedAt: "2026-11-14T12:05:00.000Z" }
    }), /does not belong/);
  });
}

test("requires a strictly pre-loss snapshot, comparing instants across timezones", () => {
  const data = fixtures();
  data.snapshot.capturedAt = "2026-11-14T12:30:00.000+01:00";
  assert.ok(evaluateRecoveryEvidence(...Object.values(data)).reasons.includes("snapshot_after_loss"));
  data.snapshot.capturedAt = "2026-11-14T12:29:59.999+01:00";
  assert.equal(evaluateRecoveryEvidence(...Object.values(data)).eligible, true);
});

test("rejects timestamps without explicit timezones at each input boundary", () => {
  const data = fixtures();
  const localTime = "2026-11-14T12:00:00.000";
  assert.throws(() => createRecoveryCase({ ...data.recoveryCase, requestedAt: localTime }), /timezone/);
  for (const [target, field, reason] of [
    ["snapshot", "capturedAt", "snapshot_timestamp_invalid"],
    ["lossEvent", "occurredAt", "loss_event_timestamp_invalid"],
    ["recoveryCase", "requestedAt", "request_timestamp_invalid"]
  ]) {
    const changed = { ...data, [target]: { ...data[target], [field]: localTime } };
    assert.ok(evaluateRecoveryEvidence(...Object.values(changed)).reasons.includes(reason));
  }
  const evidence = evaluateRecoveryEvidence(...Object.values(data));
  assert.throws(() => createRecoveryClaim({
    recoveryCase: data.recoveryCase,
    evidence,
    approval: { caseId: "case-1", approvedBy: "admin-1", approvedAt: localTime }
  }), /timezone/);
});

for (const timestamp of [
  "2026-11-14 11:00:00 (UTC",
  "2026-11-14 11:00:00 (Z",
  "2026-11-14 11:00:00 (+0100",
  "2026-02-29T11:00:00Z",
  "1900-02-29T11:00:00Z",
  "2026-04-31T11:00:00Z",
  "2026-00-14T11:00:00Z",
  "2026-13-14T11:00:00Z",
  "2026-11-00T11:00:00Z",
  "2026-11-14T24:00:00Z",
  "2026-11-14T11:60:00Z",
  "2026-11-14T11:00:60Z",
  "2026-11-14T11:00:00+24:00",
  "2026-11-14T11:00:00+01:60"
]) {
  test(`rejects malformed timestamp at every boundary: ${timestamp}`, () => {
    const data = fixtures();
    assert.throws(() => createRecoveryCase({ ...data.recoveryCase, requestedAt: timestamp }), TypeError);
    for (const [target, field, reason] of [
      ["snapshot", "capturedAt", "snapshot_timestamp_invalid"],
      ["lossEvent", "occurredAt", "loss_event_timestamp_invalid"],
      ["recoveryCase", "requestedAt", "request_timestamp_invalid"]
    ]) {
      const changed = { ...data, [target]: { ...data[target], [field]: timestamp } };
      const result = evaluateRecoveryEvidence(...Object.values(changed));
      assert.equal(result.eligible, false);
      assert.ok(result.reasons.includes(reason));
    }
    const evidence = evaluateRecoveryEvidence(...Object.values(data));
    assert.throws(() => createRecoveryClaim({
      recoveryCase: data.recoveryCase,
      evidence,
      approval: { caseId: "case-1", approvedBy: "admin-1", approvedAt: timestamp }
    }), TypeError);
  });
}

test("accepts valid leap days and explicit positive and negative offsets", () => {
  const data = fixtures();
  for (const requestedAt of ["2000-02-29T12:00:00Z", "2024-02-29T12:00:00.1Z"]) {
    assert.equal(createRecoveryCase({ ...data.recoveryCase, requestedAt }).requestedAt, requestedAt);
  }
  for (const capturedAt of ["2026-11-14T12:00:00+01:00", "2026-11-14T06:00:00-0500"]) {
    data.snapshot.capturedAt = capturedAt;
    assert.equal(evaluateRecoveryEvidence(...Object.values(data)).eligible, true);
  }
});
