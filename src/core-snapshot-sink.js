const MAX_TIMEOUT_MS = 30_000;
const MAX_STATE_BYTES = 1_048_576;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SNAPSHOT_KINDS = new Set(["inventory", "tame", "ship"]);
const SNAPSHOT_REASONS = new Set(["scheduled", "pre-loss", "manual", "reconciliation"]);

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

function requiredDateTime(value, field) {
  requiredString(value, field, 64);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:?\d{2})$/.test(value) ||
      !Number.isFinite(Date.parse(value))) {
    throw new TypeError(`${field} must be an ISO date-time with an explicit timezone`);
  }
  return new Date(value).toISOString();
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

function decodeBase64(value, field, expectedBytes) {
  if (typeof value !== "string" ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new TypeError(`${field} must be canonical base64`);
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) throw new TypeError(`${field} must be canonical base64`);
  if (expectedBytes !== undefined && decoded.byteLength !== expectedBytes) {
    throw new TypeError(`${field} has an invalid byte length`);
  }
  return decoded;
}

function validateEnvelope(encryption, stateBytes) {
  if (!encryption || typeof encryption !== "object" || Array.isArray(encryption) ||
      encryption.algorithm !== "AES-256-GCM") {
    throw new TypeError("encryptSnapshot returned an unsupported envelope");
  }
  requiredString(encryption.keyId, "encryption.keyId");
  if (encryption.keyId.length > 200) throw new TypeError("encryption.keyId is too long");
  decodeBase64(encryption.nonce, "encryption.nonce", 12);
  decodeBase64(encryption.authTag, "encryption.authTag", 16);
  const ciphertext = decodeBase64(encryption.ciphertext, "encryption.ciphertext");
  if (ciphertext.byteLength !== stateBytes || ciphertext.byteLength > MAX_STATE_BYTES) {
    throw new Error("encrypted snapshot size does not match stateBytes");
  }
  return Object.freeze({
    algorithm: encryption.algorithm,
    keyId: encryption.keyId,
    nonce: encryption.nonce,
    authTag: encryption.authTag,
    ciphertext: encryption.ciphertext
  });
}

/**
 * Explicit encrypted snapshot writer for Core's server-scoped asset snapshot API.
 * Encryption and key management are injected; plaintext never leaves this process.
 */
export function createCoreSnapshotSink({
  coreOrigin,
  serverId,
  serviceToken,
  encryptSnapshot,
  fetchImpl = globalThis.fetch,
  timeoutMs = 10_000
}) {
  const origin = normalizeOrigin(coreOrigin);
  const fixedServerId = requiredUuid(serverId, "serverId");
  requiredString(serviceToken, "serviceToken");
  if (typeof encryptSnapshot !== "function") throw new TypeError("encryptSnapshot must be a function");
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new RangeError("timeoutMs must be between 1 and 30000");
  }

  const endpoint = `${origin}/integrations/servers/${encodeURIComponent(fixedServerId)}/snapshots`;

  async function persist(snapshot) {
    if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
      throw new TypeError("snapshot must be an object");
    }
    if (!snapshot.scope || typeof snapshot.scope !== "object" || Array.isArray(snapshot.scope)) {
      throw new TypeError("snapshot scope must be an object");
    }
    const snapshotServerId = requiredUuid(snapshot.scope.serverId, "scope.serverId");
    if (snapshotServerId !== fixedServerId) {
      throw new Error("snapshot server scope does not match configured Core server");
    }
    const originalSnapshotId = snapshot.snapshotId;
    const snapshotId = requiredUuid(originalSnapshotId, "snapshot.snapshotId");
    const clusterId = requiredUuid(snapshot.scope.clusterId, "scope.clusterId");
    const gridId = requiredString(snapshot.scope.gridId, "scope.gridId");
    const kind = requiredString(snapshot.kind, "snapshot.kind");
    if (!SNAPSHOT_KINDS.has(kind)) throw new TypeError("snapshot.kind must be inventory, tame, or ship");
    const assetId = requiredString(snapshot.assetId, "snapshot.assetId");
    const ownerId = requiredString(snapshot.ownerId, "snapshot.ownerId");
    const capturedAt = requiredDateTime(snapshot.capturedAt, "snapshot.capturedAt");
    const reason = requiredString(snapshot.reason, "snapshot.reason");
    if (!SNAPSHOT_REASONS.has(reason)) throw new TypeError("snapshot.reason is unsupported");
    if (snapshot.schemaVersion !== 1) throw new TypeError("snapshot.schemaVersion must be 1");
    if (!snapshot.state || typeof snapshot.state !== "object" || Array.isArray(snapshot.state)) {
      throw new TypeError("snapshot state must be a JSON object");
    }

    const stateJson = JSON.stringify(snapshot.state);
    const stateBytes = new TextEncoder().encode(stateJson).byteLength;
    if (stateBytes < 1 || stateBytes > MAX_STATE_BYTES) {
      throw new RangeError("snapshot state must not exceed 1 MiB");
    }
    if (snapshot.stateBytes !== stateBytes) {
      throw new Error("snapshot.stateBytes does not match serialized state");
    }

    const metadata = Object.freeze({
      snapshotId, clusterId, gridId, serverId: fixedServerId,
      kind, assetId, ownerId, capturedAt, reason,
      schemaVersion: 1, stateBytes
    });
    let encryption;
    try {
      encryption = await encryptSnapshot({ stateJson, metadata });
    } catch (error) {
      const failure = new Error("Core snapshot encryption failed");
      failure.cause = error;
      throw failure;
    }
    const envelope = validateEnvelope(encryption, stateBytes);
    const payload = { ...metadata, encryption: envelope };

    let response;
    try {
      response = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${serviceToken}`,
          "content-type": "application/json",
          accept: "application/json"
        },
        body: JSON.stringify(payload),
        redirect: "manual",
        cache: "no-store",
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (error) {
      const failure = new Error("Core encrypted snapshot persistence request failed");
      failure.cause = error;
      throw failure;
    }

    if (response.status < 200 || response.status >= 300 || response.status === 304) {
      throw new Error(`Core encrypted snapshot persistence returned HTTP ${response.status}`);
    }

    let body;
    try { body = await response.json(); } catch (error) {
      const failure = new Error("Core encrypted snapshot persistence returned invalid JSON");
      failure.cause = error;
      throw failure;
    }

    const receipt = body?.data;
    if (!receipt || receipt.snapshotId !== snapshotId || receipt.durable !== true ||
        typeof receipt.receipt !== "string" || receipt.receipt.trim().length === 0) {
      throw new Error("Core encrypted snapshot persistence returned an invalid durable receipt");
    }
    return Object.freeze({ snapshotId: originalSnapshotId, durable: true, receipt: receipt.receipt });
  }

  return Object.freeze({ persist });
}
