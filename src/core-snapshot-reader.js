const MAX_TIMEOUT_MS = 30_000;
const MAX_STATE_BYTES = 1_048_576;
const SNAPSHOT_KINDS = new Set(["inventory", "tame", "ship"]);
const SNAPSHOT_REASONS = new Set(["scheduled", "pre-loss", "manual", "reconciliation"]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function requiredString(value, field, maxLength = 200) {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maxLength) {
    throw new TypeError(`${field} must be a non-empty string of at most ${maxLength} characters`);
  }
  return value;
}

function requiredUuid(value, field) {
  requiredString(value, field, 36);
  if (!UUID_PATTERN.test(value)) throw new TypeError(`${field} must be a UUID`);
  return value.toLowerCase();
}

function normalizeOrigin(value) {
  requiredString(value, "coreOrigin");
  let url;
  try { url = new URL(value); } catch { throw new TypeError("coreOrigin must be a valid HTTPS origin"); }
  if (url.protocol !== "https:" || url.username || url.password ||
      url.search || url.hash || url.pathname !== "/") {
    throw new TypeError("coreOrigin must be an HTTPS origin without credentials, path, query, or fragment");
  }
  return url.origin;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function validDateTime(value, field) {
  requiredString(value, field, 64);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:?\d{2})$/.test(value) ||
      !Number.isFinite(Date.parse(value))) {
    throw new Error(`Core snapshot returned an invalid ${field}`);
  }
  return new Date(value).toISOString();
}

function validateMetadata(item, serverId) {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    throw new Error("Core snapshot listing returned an invalid item");
  }
  const snapshotId = requiredUuid(item.snapshotId, "snapshot.snapshotId");
  const clusterId = requiredUuid(item.clusterId, "snapshot.clusterId");
  const kind = requiredString(item.kind, "snapshot.kind");
  if (!SNAPSHOT_KINDS.has(kind)) throw new Error("Core snapshot listing returned an unsupported kind");
  const assetId = requiredString(item.assetId, "snapshot.assetId");
  const ownerId = requiredString(item.ownerId, "snapshot.ownerId");
  const gridId = requiredString(item.gridId, "snapshot.gridId");
  const capturedAt = validDateTime(item.capturedAt, "capturedAt");
  const reason = requiredString(item.reason, "snapshot.reason");
  if (!SNAPSHOT_REASONS.has(reason)) throw new Error("Core snapshot listing returned an unsupported reason");
  if (item.schemaVersion !== 1) throw new Error("Core snapshot listing returned an unsupported schema version");
  if (!Number.isSafeInteger(item.stateBytes) || item.stateBytes < 1 || item.stateBytes > MAX_STATE_BYTES) {
    throw new Error("Core snapshot listing returned an invalid state size");
  }
  return deepFreeze({
    snapshotId, kind, assetId, ownerId,
    scope: { clusterId, gridId, serverId },
    capturedAt, stateBytes: item.stateBytes, reason, schemaVersion: 1
  });
}

function validateEnvelope(item) {
  if (item.algorithm !== "AES-256-GCM") throw new Error("Core snapshot read returned an unsupported encryption algorithm");
  requiredString(item.keyId, "snapshot.keyId");
  if (typeof item.nonce !== "string" || Buffer.from(item.nonce, "base64").byteLength !== 12 ||
      Buffer.from(item.nonce, "base64").toString("base64") !== item.nonce) {
    throw new Error("Core snapshot read returned an invalid nonce");
  }
  if (typeof item.authTag !== "string" || Buffer.from(item.authTag, "base64").byteLength !== 16 ||
      Buffer.from(item.authTag, "base64").toString("base64") !== item.authTag) {
    throw new Error("Core snapshot read returned an invalid authentication tag");
  }
  if (typeof item.ciphertext !== "string" ||
      Buffer.from(item.ciphertext, "base64").toString("base64") !== item.ciphertext) {
    throw new Error("Core snapshot read returned invalid ciphertext");
  }
  return Object.freeze({
    algorithm: item.algorithm,
    keyId: item.keyId,
    nonce: item.nonce,
    authTag: item.authTag,
    ciphertext: item.ciphertext
  });
}

function cryptoMetadata(metadata) {
  return Object.freeze({
    snapshotId: metadata.snapshotId,
    clusterId: metadata.scope.clusterId,
    gridId: metadata.scope.gridId,
    serverId: metadata.scope.serverId,
    kind: metadata.kind,
    assetId: metadata.assetId,
    ownerId: metadata.ownerId,
    capturedAt: metadata.capturedAt,
    reason: metadata.reason,
    schemaVersion: metadata.schemaVersion,
    stateBytes: metadata.stateBytes
  });
}

async function validateSnapshot(item, serverId, decryptSnapshot) {
  const metadata = validateMetadata(item, serverId);
  if (item.serverId !== undefined && item.serverId !== serverId) {
    throw new Error("Core snapshot read returned a different server scope");
  }
  const encryption = validateEnvelope(item);
  let state;
  try {
    state = await decryptSnapshot({ encryption, metadata: cryptoMetadata(metadata) });
  } catch (error) {
    const failure = new Error("Core snapshot decryption or authentication failed");
    failure.cause = error;
    throw failure;
  }
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    throw new Error("Core snapshot decryption returned invalid state");
  }
  return deepFreeze({ ...metadata, state });
}

/**
 * Explicit, read-only client for Core's encrypted asset snapshot API.
 * The server ID is fixed at construction; decryption keys stay outside Core.
 */
export function createCoreSnapshotReader({
  coreOrigin,
  serverId,
  serviceToken,
  decryptSnapshot,
  fetchImpl = globalThis.fetch,
  timeoutMs = 10_000
}) {
  const origin = normalizeOrigin(coreOrigin);
  const fixedServerId = requiredUuid(serverId, "serverId");
  requiredString(serviceToken, "serviceToken");
  if (typeof decryptSnapshot !== "function") throw new TypeError("decryptSnapshot must be a function");
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new RangeError("timeoutMs must be between 1 and 30000");
  }

  const basePath = `${origin}/integrations/servers/${encodeURIComponent(fixedServerId)}/snapshots`;

  async function request(url, operation) {
    let response;
    try {
      response = await fetchImpl(url, {
        method: "GET",
        headers: { authorization: `Bearer ${serviceToken}`, accept: "application/json" },
        redirect: "manual",
        cache: "no-store",
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (error) {
      const failure = new Error(`Core encrypted snapshot ${operation} request failed`);
      failure.cause = error;
      throw failure;
    }
    if (response.status < 200 || response.status >= 300 || response.status === 304) {
      throw new Error(`Core encrypted snapshot ${operation} returned HTTP ${response.status}`);
    }
    try { return await response.json(); } catch (error) {
      const failure = new Error(`Core encrypted snapshot ${operation} returned invalid JSON`);
      failure.cause = error;
      throw failure;
    }
  }

  async function list({ kind, assetId, ownerId, before, limit = 25 } = {}) {
    if (!SNAPSHOT_KINDS.has(kind)) throw new TypeError("kind must be inventory, tame, or ship");
    requiredString(assetId, "assetId");
    requiredString(ownerId, "ownerId");
    if (before !== undefined) validDateTime(before, "before");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new RangeError("limit must be an integer between 1 and 100");
    }

    const url = new URL(basePath);
    url.searchParams.set("kind", kind);
    url.searchParams.set("assetId", assetId);
    url.searchParams.set("ownerId", ownerId);
    if (before !== undefined) url.searchParams.set("before", before);
    url.searchParams.set("limit", String(limit));

    const body = await request(url.toString(), "listing");
    if (!Array.isArray(body?.data)) throw new Error("Core snapshot listing returned an invalid response");
    const items = body.data.map((item) => validateMetadata(item, fixedServerId));
    if (items.some((item) => item.kind !== kind || item.assetId !== assetId)) {
      throw new Error("Core snapshot listing returned a different kind or asset scope");
    }
    if (items.some((item) => item.ownerId !== ownerId)) {
      throw new Error("Core snapshot listing returned a different owner scope");
    }
    return Object.freeze(items);
  }

  async function get(snapshotId) {
    const id = requiredUuid(snapshotId, "snapshotId");
    const body = await request(`${basePath}/${encodeURIComponent(id)}`, "read");
    if (!body?.data || typeof body.data !== "object" || Array.isArray(body.data)) {
      throw new Error("Core snapshot read returned an invalid response");
    }
    const snapshot = await validateSnapshot(body.data, fixedServerId, decryptSnapshot);
    if (snapshot.snapshotId !== id) {
      throw new Error("Core snapshot read returned a different snapshot ID");
    }
    return snapshot;
  }

  return Object.freeze({ list, get });
}
