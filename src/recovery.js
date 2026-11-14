const LOSS_EVENT_TYPES = Object.freeze({
  inventory: Object.freeze(["player.died"]),
  tame: Object.freeze(["tame.died"]),
  ship: Object.freeze(["ship.sunk"])
});

const RECOVERY_KINDS = Object.freeze(Object.keys(LOSS_EVENT_TYPES));

function requiredString(value, field) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value;
}

function validDate(value, field) {
  requiredString(value, field);
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-](\d{2}):?(\d{2}))$/i.exec(value);
  if (!match) {
    throw new TypeError(`${field} must be an ISO date-time with an explicit timezone`);
  }
  const [, year, month, day, hour, minute, second, , offsetHour = "0", offsetMinute = "0"] = match;
  const leapYear = +year % 4 === 0 && (+year % 100 !== 0 || +year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const time = Date.parse(value);
  if (+month < 1 || +month > 12 || +day < 1 || +day > daysInMonth[+month - 1]
    || +hour > 23 || +minute > 59 || +second > 59 || +offsetHour > 23 || +offsetMinute > 59
    || !Number.isFinite(time)) {
    throw new TypeError(`${field} must be a valid date-time`);
  }
  return time;
}

function validScope(scope, field = "scope") {
  if (!scope || typeof scope !== "object" || Array.isArray(scope)) {
    throw new TypeError(`${field} must be an object`);
  }
  return Object.freeze({
    clusterId: requiredString(scope.clusterId, `${field}.clusterId`),
    gridId: requiredString(scope.gridId, `${field}.gridId`),
    serverId: requiredString(scope.serverId, `${field}.serverId`)
  });
}

function sameScope(left, right) {
  return left?.clusterId === right?.clusterId
    && left?.gridId === right?.gridId
    && left?.serverId === right?.serverId;
}

function immutableResult(value) {
  return Object.freeze(value);
}

export function createRecoveryCase(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("recovery case input must be an object");
  }
  if (!RECOVERY_KINDS.includes(input.kind)) {
    throw new TypeError("kind must be inventory, tame, or ship");
  }

  const requestedAt = requiredString(input.requestedAt, "requestedAt");
  validDate(requestedAt, "requestedAt");

  return immutableResult({
    caseId: requiredString(input.caseId, "caseId"),
    kind: input.kind,
    requesterId: requiredString(input.requesterId, "requesterId"),
    ownerId: requiredString(input.ownerId, "ownerId"),
    assetId: requiredString(input.assetId, "assetId"),
    snapshotId: requiredString(input.snapshotId, "snapshotId"),
    lossEventId: requiredString(input.lossEventId, "lossEventId"),
    scope: validScope(input.scope),
    requestedAt,
    status: "pending_review"
  });
}

export function evaluateRecoveryEvidence(recoveryCase, snapshot, lossEvent) {
  const reasons = [];

  if (!recoveryCase || typeof recoveryCase !== "object") {
    throw new TypeError("recoveryCase must be an object");
  }
  if (!snapshot || typeof snapshot !== "object") {
    throw new TypeError("snapshot must be an object");
  }
  if (!lossEvent || typeof lossEvent !== "object") {
    throw new TypeError("lossEvent must be an object");
  }

  const allowedEvents = LOSS_EVENT_TYPES[recoveryCase.kind];
  if (!allowedEvents) throw new TypeError("recoveryCase.kind is unsupported");

  if (snapshot.snapshotId !== recoveryCase.snapshotId) reasons.push("snapshot_id_mismatch");
  if (snapshot.kind !== recoveryCase.kind) reasons.push("snapshot_kind_mismatch");
  if (snapshot.assetId !== recoveryCase.assetId) reasons.push("snapshot_asset_mismatch");
  if (snapshot.ownerId !== recoveryCase.ownerId) reasons.push("snapshot_owner_mismatch");
  if (lossEvent.eventId !== recoveryCase.lossEventId) reasons.push("loss_event_id_mismatch");
  if (!allowedEvents.includes(lossEvent.eventType)) reasons.push("loss_event_type_unsupported");
  if (lossEvent.assetId !== recoveryCase.assetId) reasons.push("loss_event_asset_mismatch");
  if (lossEvent.ownerId !== recoveryCase.ownerId) reasons.push("loss_event_owner_mismatch");

  let snapshotScope;
  let eventScope;
  try {
    snapshotScope = validScope(snapshot.scope, "snapshot.scope");
  } catch {
    reasons.push("snapshot_scope_invalid");
  }
  try {
    eventScope = validScope(lossEvent.scope, "lossEvent.scope");
  } catch {
    reasons.push("loss_event_scope_invalid");
  }
  if (snapshotScope && !sameScope(snapshotScope, recoveryCase.scope)) {
    reasons.push("snapshot_scope_mismatch");
  }
  if (eventScope && !sameScope(eventScope, recoveryCase.scope)) {
    reasons.push("loss_event_scope_mismatch");
  }

  let capturedAt;
  let occurredAt;
  let requestedAt;
  try {
    capturedAt = validDate(snapshot.capturedAt, "snapshot.capturedAt");
  } catch {
    reasons.push("snapshot_timestamp_invalid");
  }
  try {
    occurredAt = validDate(lossEvent.occurredAt, "lossEvent.occurredAt");
  } catch {
    reasons.push("loss_event_timestamp_invalid");
  }
  try {
    requestedAt = validDate(recoveryCase.requestedAt, "recoveryCase.requestedAt");
  } catch {
    reasons.push("request_timestamp_invalid");
  }

  if (capturedAt !== undefined && occurredAt !== undefined && capturedAt >= occurredAt) {
    reasons.push("snapshot_after_loss");
  }
  if (occurredAt !== undefined && requestedAt !== undefined && requestedAt < occurredAt) {
    reasons.push("request_before_loss");
  }
  if (!snapshot.state || typeof snapshot.state !== "object" || Array.isArray(snapshot.state)) {
    reasons.push("snapshot_state_missing");
  }

  return immutableResult({
    caseId: recoveryCase.caseId,
    kind: recoveryCase.kind,
    requesterId: recoveryCase.requesterId,
    ownerId: recoveryCase.ownerId,
    assetId: recoveryCase.assetId,
    scope: validScope(recoveryCase.scope),
    requestedAt: recoveryCase.requestedAt,
    snapshotId: recoveryCase.snapshotId,
    lossEventId: recoveryCase.lossEventId,
    eligible: reasons.length === 0,
    reasons: Object.freeze(reasons)
  });
}

export function createRecoveryClaim({ recoveryCase, evidence, approval }) {
  if (!recoveryCase || typeof recoveryCase !== "object") {
    throw new TypeError("recoveryCase is required");
  }
  if (!evidence?.eligible) {
    throw new Error("recovery evidence must be eligible before approval");
  }
  if (evidence.caseId !== recoveryCase.caseId
    || evidence.snapshotId !== recoveryCase.snapshotId
    || evidence.lossEventId !== recoveryCase.lossEventId
    || evidence.kind !== recoveryCase.kind
    || evidence.requesterId !== recoveryCase.requesterId
    || evidence.ownerId !== recoveryCase.ownerId
    || evidence.assetId !== recoveryCase.assetId
    || !sameScope(evidence.scope, recoveryCase.scope)
    || evidence.requestedAt !== recoveryCase.requestedAt) {
    throw new Error("recovery evidence does not belong to this case");
  }
  if (!approval || typeof approval !== "object") {
    throw new TypeError("explicit approval is required");
  }
  if (approval.caseId !== recoveryCase.caseId) {
    throw new Error("approval caseId does not match recovery case");
  }

  const approvedBy = requiredString(approval.approvedBy, "approval.approvedBy");
  const approvedAt = requiredString(approval.approvedAt, "approval.approvedAt");
  if (validDate(approvedAt, "approval.approvedAt") < validDate(recoveryCase.requestedAt, "recoveryCase.requestedAt")) {
    throw new Error("approval cannot predate the recovery request");
  }

  const kind = recoveryCase.kind;
  const caseId = recoveryCase.caseId;
  const idempotencyKey = `cmg-recovery:v1:${kind.length}:${kind}:${caseId.length}:${caseId}`;

  return immutableResult({
    claimId: idempotencyKey,
    idempotencyKey,
    caseId,
    kind,
    assetId: recoveryCase.assetId,
    ownerId: recoveryCase.ownerId,
    scope: recoveryCase.scope,
    approvedBy,
    approvedAt,
    status: "prepared",
    providerReceipt: null
  });
}

export function completeRecoveryClaim(claim, providerReceipt) {
  if (!claim || typeof claim !== "object") throw new TypeError("claim is required");
  const receipt = requiredString(providerReceipt, "providerReceipt");

  if (claim.status === "restored") {
    if (claim.providerReceipt !== receipt) {
      throw new Error("a completed claim cannot be completed with a different provider receipt");
    }
    return claim;
  }
  if (claim.status !== "prepared") {
    throw new Error("only a prepared recovery claim can be completed");
  }

  return immutableResult({
    ...claim,
    status: "restored",
    providerReceipt: receipt
  });
}

export const recoveryLossEventTypes = LOSS_EVENT_TYPES;
