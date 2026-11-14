# CMG Player — Implementation Plan

## Purpose

Player utilities and progression operating consistently across the ATLAS cluster, including safe recovery of lost assets.

## Feature scope

- Suicide/self-respawn and stuck recovery
- Teleport/travel with permissions, costs, cooldowns and PvP/ship rules
- Command aliases and help
- Tame tracker, ownership, limits and custom spawns
- Skill-tree extensions where hooks permit
- Quest progression and tame-color tokens
- Ship retrieval after sinking with anti-duplication controls
- Player inventory recovery from verified pre-loss snapshots
- Tame recovery from verified pre-death snapshots

## Dependencies

- Core player identity, scoped permissions and event ingestion
- ATLAS adapter: player/location/inventory/tame/ship/skill callbacks
- Tribes for ownership; Commerce for tokens
- World for safe zones/limits; Adventures for quests

## Data ownership

Core owns identity and permissions. Player owns cooldowns, destinations, recovery requests, inventory/tame snapshots, progression and ship-recovery claims. Preserve provider IDs and grid context.

## Recovery workflow

See [RECOVERY.md](RECOVERY.md). The recovery foundation is intentionally split from live game integration:

1. Define and test canonical snapshot, loss-event, and recovery-claim contracts.
2. Prove snapshot capture and ownership callbacks for inventory, tames, and ships.
3. Prove restore operations and provider-side idempotency on an isolated server.
4. Add durable persistence, scoped authorization, audit records, and operator/player workflows.
5. Enable each recovery type independently only after its compatibility gates pass.

## Milestones

1. Build feature-to-hook capability matrix.
2. Implement commands/help with fake adapter.
3. Add recovery policy and evidence validation (server-independent foundation).
4. Add recovery only after respawn/location and inventory/tame/ship callbacks are verified.
5. Add grid-aware teleport.
6. Add tame features and ship recovery after ownership hooks are proven.
7. Integrate skill trees and quests behind capability flags.

## Technical gates and risks

- Destructive actions require server-authoritative callbacks and idempotency.
- Skill-tree changes may require deeper integration/client assets.
- Ship recovery requires tested sinking/destruction source.
- Inventory recovery must distinguish a real inventory loss from an ordinary player death.
- Tame recovery must preserve ownership and prevent duplicate entities.
- A restore is not complete until the provider confirms it and a durable receipt is recorded.

## Shared engineering requirements

- Use authenticated, least-privilege Core APIs; no direct database credentials in plugins.
- Preserve provider identifiers as strings; display names are not identifiers.
- Carry cluster, grid and server context on applicable records/events.
- Use stable event IDs, idempotency keys and correlation IDs.
- Keep network work off game-critical threads; use bounded timeouts, retries and circuit breakers.
- Keep secrets out of source control and separate credentials per server/integration.
- Add unit tests, fake-adapter contract tests and isolated runtime compatibility tests.
- Gate unsupported features behind explicit capabilities; fail closed for privileged actions.
- Do not deploy to production or change live server configuration during repository planning.

## Current readiness

Documentation, policy, and fake-adapter scaffolding only. Exact ATLAS server build, loader, SDK, callbacks, and feature-specific capabilities require isolated reproducible validation.
