const RECOVERY_KINDS = new Set(["inventory", "tame", "ship"]);
const REQUIRED_SCOPE_FIELDS = Object.freeze(["clusterId", "gridId", "serverId"]);
const DEFAULT_MAX_STATE_BYTES = 1024 * 1024;
const MAX_STATE_DEPTH = 64;
const MAX_STATE_NODES = 50000;

function requireString(value, field) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value;
}

function requireIsoDateTime(value, field) {
  requireString(value, field);
  const match = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(\.\d{1,3})?(Z|[+-](?:[01]\d|2[0-3]):?[0-5]\d)$/i.exec(value);
  if (!match) throw new TypeError(`${field} must be an ISO date-time with an explicit timezone`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const days = [31, year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1] || !Number.isFinite(Date.parse(value))) {
    throw new TypeError(`${field} must be a valid calendar date`);
  }
  return value;
}

function normalizeScope(scope) {
  if (!scope || typeof scope !== "object" || Array.isArray(scope)) {
    throw new TypeError("scope must be an object");
  }
  const normalized = {};
  for (const field of REQUIRED_SCOPE_FIELDS) {
    normalized[field] = requireString(scope[field], `scope.${field}`);
  }
  return Object.freeze(normalized);
}

function chargeBytes(counter, bytes) {
  counter.bytes += bytes;
  if (counter.bytes > counter.maxBytes) throw new RangeError("snapshot state exceeds maxStateBytes");
}

function chargeString(counter, value) {
  // Each UTF-16 code unit requires at least one byte in JSON. Check before allocating.
  if (value.length > counter.maxBytes - counter.bytes) {
    throw new RangeError("snapshot state exceeds maxStateBytes");
  }
  chargeBytes(counter, new TextEncoder().encode(JSON.stringify(value)).byteLength);
}

function cloneJsonValue(value, path, depth, counter) {
  counter.nodes += 1;
  if (counter.nodes > MAX_STATE_NODES) throw new TypeError("snapshot state exceeds maximum node count");
  if (depth > MAX_STATE_DEPTH) throw new TypeError("snapshot state exceeds maximum nesting depth");

  if (typeof value === "string") {
    chargeString(counter, value);
    return value;
  }
  if (value === null || typeof value === "boolean") {
    chargeBytes(counter, value === null ? 4 : value ? 4 : 5);
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`${path} contains a non-finite number`);
    chargeBytes(counter, JSON.stringify(value).length);
    return value;
  }
  if (typeof value !== "object") throw new TypeError(`${path} contains a non-JSON value`);

  if (Array.isArray(value)) {
    chargeBytes(counter, 2);
    const result = [];
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) throw new TypeError(`${path} contains a sparse array`);
      if (index > 0) chargeBytes(counter, 1);
      result.push(cloneJsonValue(value[index], `${path}[${index}]`, depth + 1, counter));
    }
    return Object.freeze(result);
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${path} must contain only plain JSON objects`);
  }
  chargeBytes(counter, 2);
  const result = {};
  let first = true;
  for (const key of Object.keys(value)) {
    chargeBytes(counter, first ? 1 : 2);
    first = false;
    chargeString(counter, key);
    const child = value[key];
    Object.defineProperty(result, key, {
      value: cloneJsonValue(child, `${path}.${key}`, depth + 1, counter),
      enumerable: true,
      writable: false,
      configurable: false
    });
  }
  return Object.freeze(result);
}

function scopeKey(scope) {
  return REQUIRED_SCOPE_FIELDS.map((field) => {
    const value = scope[field];
    return `${value.length}:${value}`;
  }).join("|");
}

function snapshotKey(kind, assetId, scope) {
  return [kind, assetId, scopeKey(scope)].map((value) => `${value.length}:${value}`).join("|");
}

/**
 * Create an explicitly invoked snapshot capture service.
 *
 * The source adapter is responsible for obtaining authoritative game state.
 * The sink adapter is responsible for durable, access-controlled storage.
 * This module deliberately provides no scheduler or native ATLAS callbacks.
 */
export function createSnapshotCapture({
  source,
  sink,
  createSnapshotId,
  clock = () => new Date().toISOString(),
  maxStateBytes = DEFAULT_MAX_STATE_BYTES
}) {
  if (!source || typeof source.capture !== "function") {
    throw new TypeError("source.capture must be a function");
  }
  if (!sink || typeof sink.persist !== "function") {
    throw new TypeError("sink.persist must be a function");
  }
  if (typeof createSnapshotId !== "function") {
    throw new TypeError("createSnapshotId must be a function");
  }
  if (!Number.isSafeInteger(maxStateBytes) || maxStateBytes < 1 || maxStateBytes > DEFAULT_MAX_STATE_BYTES) {
    throw new RangeError("maxStateBytes must be between 1 byte and 1 MiB");
  }

  const inFlight = new Map();

  async function capture({ kind, assetId, scope, reason = "scheduled" }) {
    if (!RECOVERY_KINDS.has(kind)) throw new TypeError("kind must be inventory, tame, or ship");
    requireString(assetId, "assetId");
    requireString(reason, "reason");
    const normalizedScope = normalizeScope(scope);
    const key = snapshotKey(kind, assetId, normalizedScope);

    if (inFlight.has(key)) return inFlight.get(key);

    const operation = (async () => {
      const startedAt = requireIsoDateTime(clock(), "capturedAt");
      const sourceResult = await source.capture(Object.freeze({
        kind,
        assetId,
        scope: normalizedScope
      }));

      if (!sourceResult || typeof sourceResult !== "object" || Array.isArray(sourceResult)) {
        throw new TypeError("source.capture must return a snapshot object");
      }
      const ownerId = requireString(sourceResult.ownerId, "source.ownerId");
      if (sourceResult.assetId !== assetId) throw new Error("source returned a different assetId");
      const sourceScope = normalizeScope(sourceResult.scope);
      if (scopeKey(sourceScope) !== scopeKey(normalizedScope)) {
        throw new Error("source returned a different cluster/grid/server scope");
      }

      const state = cloneJsonValue(sourceResult.state, "state", 0, { nodes: 0, bytes: 0, maxBytes: maxStateBytes });
      if (!state || typeof state !== "object" || Array.isArray(state)) {
        throw new TypeError("source state must be a JSON object");
      }
      const stateJson = JSON.stringify(state);
      const stateBytes = new TextEncoder().encode(stateJson).byteLength;
      if (stateBytes > maxStateBytes) throw new RangeError("snapshot state exceeds maxStateBytes");

      const capturedAt = requireIsoDateTime(clock(), "capturedAt");
      if (Date.parse(capturedAt) < Date.parse(startedAt)) {
        throw new Error("capture clock moved backwards");
      }
      const snapshotId = requireString(createSnapshotId(), "snapshotId");
      const snapshot = Object.freeze({
        schemaVersion: 1,
        snapshotId,
        kind,
        assetId,
        ownerId,
        scope: normalizedScope,
        capturedAt,
        reason,
        state,
        stateBytes
      });

      const persisted = await sink.persist(snapshot);
      if (!persisted || typeof persisted !== "object" || Array.isArray(persisted)) {
        throw new Error("snapshot sink did not confirm durable persistence");
      }
      if (persisted.snapshotId !== snapshotId || persisted.durable !== true) {
        throw new Error("snapshot sink returned an invalid persistence receipt");
      }
      const receipt = requireString(persisted.receipt, "persistence receipt");

      return Object.freeze({
        snapshot,
        persistence: Object.freeze({ snapshotId, durable: true, receipt })
      });
    })();

    inFlight.set(key, operation);
    try {
      return await operation;
    } finally {
      if (inFlight.get(key) === operation) inFlight.delete(key);
    }
  }

  return Object.freeze({ capture });
}
