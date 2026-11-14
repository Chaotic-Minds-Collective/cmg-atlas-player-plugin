const MAX_TIMEOUT_MS = 30_000;
const MAX_STATE_BYTES = 16 * 1024 * 1024;

function requiredString(value, field) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value;
}

function normalizeOrigin(value) {
  requiredString(value, "coreOrigin");
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("coreOrigin must be a valid HTTPS origin");
  }
  if (url.protocol !== "https:" || url.username || url.password ||
      url.search || url.hash || url.pathname !== "/") {
    throw new TypeError("coreOrigin must be an HTTPS origin without credentials, path, query, or fragment");
  }
  return url.origin;
}

/**
 * Create an explicitly invoked sink for the Core recovery snapshot API.
 * Credentials and server scope are supplied by the host configuration;
 * no environment variables or global process state are read here.
 */
export function createCoreSnapshotSink({
  coreOrigin,
  serverId,
  serviceToken,
  fetchImpl = globalThis.fetch,
  timeoutMs = 10_000
}) {
  const origin = normalizeOrigin(coreOrigin);
  requiredString(serverId, "serverId");
  requiredString(serviceToken, "serviceToken");
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new RangeError("timeoutMs must be between 1 and 30000");
  }

  const endpoint = `${origin}/integrations/servers/${encodeURIComponent(serverId)}/recovery/snapshots`;

  async function persist(snapshot) {
    if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
      throw new TypeError("snapshot must be an object");
    }
    if (!snapshot.scope || snapshot.scope.serverId !== serverId) {
      throw new Error("snapshot server scope does not match configured Core server");
    }
    if (typeof snapshot.state !== "object" || snapshot.state === null || Array.isArray(snapshot.state)) {
      throw new TypeError("snapshot state must be a JSON object");
    }

    const stateJson = JSON.stringify(snapshot.state);
    const stateBytes = new TextEncoder().encode(stateJson).byteLength;
    if (stateBytes < 1 || stateBytes > MAX_STATE_BYTES) {
      throw new RangeError("snapshot state must not exceed 16 MiB");
    }

    // Deliberately map the capture object to Core's strict API schema.
    // Local-only schemaVersion and stateBytes are not sent.
    const payload = {
      snapshotId: requiredString(snapshot.snapshotId, "snapshot.snapshotId"),
      kind: requiredString(snapshot.kind, "snapshot.kind"),
      assetId: requiredString(snapshot.assetId, "snapshot.assetId"),
      ownerId: requiredString(snapshot.ownerId, "snapshot.ownerId"),
      scope: {
        clusterId: requiredString(snapshot.scope.clusterId, "scope.clusterId"),
        gridId: requiredString(snapshot.scope.gridId, "scope.gridId"),
        serverId
      },
      capturedAt: requiredString(snapshot.capturedAt, "snapshot.capturedAt"),
      state: snapshot.state,
      reason: requiredString(snapshot.reason, "snapshot.reason")
    };

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
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (error) {
      // Never include request headers or the service token in surfaced errors.
      const failure = new Error("Core snapshot persistence request failed");
      failure.cause = error;
      throw failure;
    }

    if (response.status < 200 || response.status >= 300 || response.status === 304) {
      throw new Error(`Core snapshot persistence returned HTTP ${response.status}`);
    }

    let body;
    try {
      body = await response.json();
    } catch (error) {
      const failure = new Error("Core snapshot persistence returned invalid JSON");
      failure.cause = error;
      throw failure;
    }

    const receipt = body?.data;
    if (!receipt || receipt.snapshotId !== payload.snapshotId ||
        receipt.durable !== true || typeof receipt.receipt !== "string" ||
        receipt.receipt.trim().length === 0) {
      throw new Error("Core snapshot persistence returned an invalid durable receipt");
    }

    return Object.freeze({
      snapshotId: receipt.snapshotId,
      durable: true,
      receipt: receipt.receipt
    });
  }

  return Object.freeze({ persist });
}
