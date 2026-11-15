const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_BATCH_SIZE = 50;
const MIN_LEASE_MS = 1_000;
const MAX_LEASE_MS = 5 * 60_000;

function requireFunction(value, field) {
  if (typeof value !== "function") {
    throw new TypeError(`${field} must be a function`);
  }
  return value;
}

function requireString(value, field) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value;
}

function toIsoTimestamp(value, field) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new TypeError(`${field} must return a valid date or timestamp`);
  }
  return date.toISOString();
}

function validateCooldown(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new TypeError("claimed cooldown must be an object");
  }

  return {
    cooldownId: requireString(record.cooldownId, "cooldownId"),
    tameId: requireString(record.tameId, "tameId"),
    ownerId: requireString(record.ownerId, "ownerId"),
    tameName: typeof record.tameName === "string" && record.tameName.trim()
      ? record.tameName.trim()
      : record.tameId,
    expiresAt: toIsoTimestamp(record.expiresAt, "expiresAt"),
    leaseToken: requireString(record.leaseToken, "leaseToken")
  };
}

/**
 * Builds a provider-neutral worker for notifying tame owners when breeding
 * cooldowns expire. Persistence, scheduling, and game chat are injected.
 *
 * The store must atomically lease due, unnotified cooldowns and persist the
 * notification acknowledgement. The delivery adapter must honor the stable
 * idempotency key to prevent duplicate chat messages across worker retries.
 */
export function createBreedingCooldownNotifier({
  store,
  sendMessage,
  clock = () => new Date(),
  leaseMs = DEFAULT_LEASE_MS,
  batchSize = DEFAULT_BATCH_SIZE
} = {}) {
  if (!store || typeof store !== "object" || Array.isArray(store)) {
    throw new TypeError("store must be an object");
  }

  const claimExpired = requireFunction(store.claimExpired, "store.claimExpired");
  const markNotified = requireFunction(store.markNotified, "store.markNotified");
  const releaseClaim = requireFunction(store.releaseClaim, "store.releaseClaim");
  const deliver = requireFunction(sendMessage, "sendMessage");
  const getNow = requireFunction(clock, "clock");

  if (!Number.isInteger(leaseMs) || leaseMs < MIN_LEASE_MS || leaseMs > MAX_LEASE_MS) {
    throw new RangeError("leaseMs must be an integer between 1000 and 300000");
  }
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 100) {
    throw new RangeError("batchSize must be an integer between 1 and 100");
  }

  async function processExpired() {
    const now = toIsoTimestamp(getNow(), "clock");
    const claimed = await claimExpired({
      now,
      leaseMs,
      limit: batchSize
    });

    if (!Array.isArray(claimed)) {
      throw new TypeError("store.claimExpired must return an array");
    }

    const result = { claimed: claimed.length, notified: 0, failed: 0 };

    for (const rawRecord of claimed) {
      const cooldown = validateCooldown(rawRecord);
      const idempotencyKey = `cmg:breeding-ready:v1:${cooldown.cooldownId}`;

      try {
        const delivery = await deliver({
          recipientId: cooldown.ownerId,
          idempotencyKey,
          message: `Your tame ${cooldown.tameName} is ready to breed again! The 30-minute coloring cooldown has ended, and breeding is available.`,
          metadata: Object.freeze({
            event: "tame.breeding_cooldown.expired",
            cooldownId: cooldown.cooldownId,
            tameId: cooldown.tameId
          })
        });

        const receipt = requireString(delivery?.receipt, "sendMessage receipt");
        await markNotified({
          cooldownId: cooldown.cooldownId,
          leaseToken: cooldown.leaseToken,
          notifiedAt: toIsoTimestamp(getNow(), "clock"),
          deliveryReceipt: receipt,
          idempotencyKey
        });
        result.notified += 1;
      } catch (error) {
        result.failed += 1;
        try {
          await releaseClaim({
            cooldownId: cooldown.cooldownId,
            leaseToken: cooldown.leaseToken
          });
        } catch {
          // The lease must expire naturally if release fails.
        }
      }
    }

    return Object.freeze(result);
  }

  return Object.freeze({ processExpired });
}
