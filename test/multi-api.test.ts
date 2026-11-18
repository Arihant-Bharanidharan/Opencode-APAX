/**
 * Tests for MultiApiManager (v2.1 multi-API control plane).
 *
 * No real HTTP calls. Verifies endpoint registration, circuit-breaker health,
 * token-bucket rate limiting, load balancing, failover, selection, snapshots,
 * default config, and tier profiles.
 *
 * Follows the check() + process.exit(fail === 0 ? 0 : 1) convention.
 *
 * Copyright (c) 2026 Arihant Bharanidharan <arihantbharani@outlook.com>
 * SPDX-License-Identifier: MIT
 */

import { MultiApiManager, DEFAULT_MULTI_API_CONFIG, MODEL_TIER_PROFILES, intelligenceToTier, estimateCost } from "../src/runtime/multi-api.js"
import type { ApiEndpoint } from "../src/runtime/types.js"

let pass = 0
let fail = 0
const check = (name: string, cond: boolean, detail = "") => {
  if (cond) {
    pass++
    console.log(`[PASS] ${name}`)
  } else {
    fail++
    console.log(`[FAIL] ${name}${detail ? ` - ${detail}` : ""}`)
  }
}

function makeEndpoint(overrides: Partial<ApiEndpoint> = {}): ApiEndpoint {
  return {
    id: overrides.id ?? "ep-test",
    name: overrides.name ?? "Test Endpoint",
    provider: overrides.provider ?? "test",
    baseUrl: overrides.baseUrl ?? "https://test.example.com",
    apiKeyEnv: overrides.apiKeyEnv ?? "TEST_API_KEY",
    models: overrides.models ?? ["mimo-v2.6-flash-free"],
    rateLimitPerSecond: overrides.rateLimitPerSecond ?? 4,
    burst: overrides.burst ?? 8,
    costTier: (overrides.costTier ?? 0) as 0 | 1 | 2 | 3,
    intelligence: overrides.intelligence ?? 0.66,
    enabled: overrides.enabled ?? true,
  }
}

// ---- constructor / registration / listing ----
{
  const mgr = new MultiApiManager(DEFAULT_MULTI_API_CONFIG)
  check("constructor loads default endpoint", mgr.listEndpoints().length === 1, `count=${mgr.listEndpoints().length}`)
  check("default endpoint id", mgr.getEndpoint("opencode-default") !== undefined)
  check("default provider", mgr.getDefaultProvider() === "opencode")

  const extra = makeEndpoint({ id: "ep-second", models: ["mimo-v2.6-flash-free", "mimo-v2.6-reasoning"], intelligence: 0.85 })
  mgr.register(extra)
  check("register adds endpoint", mgr.getEndpoint("ep-second") !== undefined)
  check("listEndpoints returns both", mgr.listEndpoints().length === 2, `count=${mgr.listEndpoints().length}`)

  const unreg = mgr.unregister("ep-second")
  check("unregister removes endpoint", unreg === true && mgr.getEndpoint("ep-second") === undefined)
  check("unregister missing returns false", mgr.unregister("no-such-id") === false)

  const disabled = new MultiApiManager(DEFAULT_MULTI_API_CONFIG)
  disabled.register(makeEndpoint({ id: "disabled-ep", enabled: false }))
  check("setEnabled false disables", disabled.setEnabled("disabled-ep", false) === true && disabled.getEndpoint("disabled-ep")!.enabled === false)
  check("setEnabled true re-enables", disabled.setEnabled("disabled-ep", true) === true && disabled.getEndpoint("disabled-ep")!.enabled === true)
  check("setEnabled missing returns false", disabled.setEnabled("no-such", true) === false)

  check("unregister non-existent returns false", mgr.unregister("does-not-exist") === false)
}

// ---- selectEndpoint: model match, exclusion, preference, rate limit ----
{
  const mgr = new MultiApiManager(DEFAULT_MULTI_API_CONFIG)
  mgr.register(makeEndpoint({ id: "ep-a", models: ["mimo-v2.6-flash-free"], intelligence: 0.66 }))
  mgr.register(makeEndpoint({ id: "ep-b", models: ["mimo-v2.6-reasoning"], intelligence: 0.9 }))

  const hosted = mgr.selectEndpoint("mimo-v2.6-flash-free")
  check("selectEndpoint returns endpoint for hosted model", hosted !== null && (hosted.endpointId === "ep-a" || hosted.endpointId === "opencode-default"), `got ${hosted?.endpointId ?? "null"}`)
  check("selectEndpoint returns null for unhosted model", mgr.selectEndpoint("mimo-v2.6-unknown") === null)

  const sel = mgr.selectEndpoint("mimo-v2.6-flash-free", [], ["ep-a"])
  check("selectEndpoint honors prefer", sel?.endpointId === "ep-a", sel?.endpointId ?? "null")

  const excl = mgr.selectEndpoint("mimo-v2.6-flash-free", ["ep-a", "opencode-default"], [])
  check("selectEndpoint honors exclude", excl === null, `got ${excl?.endpointId ?? "null"}`)
}

// ---- circuit breaker: record ok / failure / open / cooldown ----
// Note: isAllowed() uses this.now() for time, allowing mocked time in tests
{
  const mgr = new MultiApiManager(DEFAULT_MULTI_API_CONFIG)
  const ep = makeEndpoint({ id: "cb-ep" })
  mgr.register(ep)

  check("isAllowed true when closed", mgr.isAllowed("cb-ep") === true)

  // 3 failures -> open
  mgr.record("cb-ep", "error")
  mgr.record("cb-ep", "error")
  mgr.record("cb-ep", "error")
  check("isAllowed false after 3 failures (open)", mgr.isAllowed("cb-ep") === false)
  check("snapshot shows open state", mgr.snapshot().find((s) => s.id === "cb-ep")!.state === "open", `state=${mgr.snapshot().find((s) => s.id === "cb-ep")!.state}`)

  // ok closes it again
  mgr.record("cb-ep", "ok")
  check("isAllowed true after ok (closed)", mgr.isAllowed("cb-ep") === true)
}

// ---- circuit breaker cooldown test ----
// Test that after cooldown elapses, isAllowed returns true and state is half_open
{
  const baseTime = 4_000_000_000_000
  const mgr = new MultiApiManager(DEFAULT_MULTI_API_CONFIG, () => baseTime)
  mgr.register(makeEndpoint({ id: "cb-cooldown" }))
  mgr.record("cb-cooldown", "error")
  mgr.record("cb-cooldown", "error")
  mgr.record("cb-cooldown", "error")

  // At baseTime, cooldown hasn't elapsed (60s)
  check("isAllowed false during cooldown", mgr.isAllowed("cb-cooldown") === false)

  // Manually set openedAt to allow testing cooldown transition
  const rec = (mgr as unknown as { health: Map<string, { health: { state: string; openedAt: number } }> }).health.get("cb-cooldown")!
  rec.health.openedAt = baseTime - 70_000 // opened 70s ago (past 60s cooldown)
  rec.health.state = "open"

  // Now cooldown has elapsed
  check("isAllowed true after cooldown", mgr.isAllowed("cb-cooldown") === true, "expected true after cooldown")
  check("snapshot shows half_open", mgr.snapshot().find((s) => s.id === "cb-cooldown")!.state === "half_open", `state=${mgr.snapshot().find((s) => s.id === "cb-cooldown")!.state}`)
}

// ---- token bucket rate limiting ----
{
  const now = 2_000_000_000_000
  // burst=1, rate=1/sec -> 1 token, refills 1/sec
  const mgr = new MultiApiManager(
    {
      ...DEFAULT_MULTI_API_CONFIG,
      endpoints: [makeEndpoint({ id: "rl-ep", burst: 1, rateLimitPerSecond: 1 })],
    },
    () => now,
  )
  const id = "rl-ep"
  check("consumeToken returns null when token available", mgr.consumeToken(id) === null)
  check("consumeToken returns retryMs when exhausted", typeof mgr.consumeToken(id) === "number")
  // advance 1s -> token refilled
  mgr["now"] = () => now + 1_000 // eslint-disable-line @typescript-eslint/no-explicit-any
  check("consumeToken null after refill", mgr.consumeToken(id) === null)
}

// ---- failover: rate-limited top candidate falls back to next healthy ----
{
  const now = 3_000_000_000_000
  const mgr = new MultiApiManager(
    {
      ...DEFAULT_MULTI_API_CONFIG,
      endpoints: [
        makeEndpoint({ id: "fo-a", burst: 1, rateLimitPerSecond: 1, intelligence: 0.9 }),
        makeEndpoint({ id: "fo-b", burst: 8, rateLimitPerSecond: 10, intelligence: 0.5 }),
      ],
    },
    () => now,
  )
  // exhaust fo-a so it's rate-limited but still allowed (circuit closed)
  mgr.consumeToken("fo-a")
  const sel = mgr.selectEndpoint("mimo-v2.6-flash-free", [], [])
  // fo-a has higher intelligence score; with rate limit and failover on, should fall back to fo-b
  check("failover falls back when top candidate rate-limited", sel?.endpointId === "fo-b", sel?.endpointId ?? "null")
}

// ---- snapshot ----
{
  const mgr = new MultiApiManager(DEFAULT_MULTI_API_CONFIG)
  mgr.register(makeEndpoint({ id: "snap-ep", models: ["mimo-v2.6-flash-free"] }))
  const snaps = mgr.snapshot()
  check("snapshot includes endpoint", snaps.some((s) => s.id === "snap-ep") === true)
  const s = snaps.find((x) => x.id === "snap-ep")!
  check("snapshot fields populated", typeof s.name === "string" && typeof s.state === "string" && s.laneCount === 0)
}

// ---- resetLaneCounts / assignLane ----
{
  const mgr = new MultiApiManager(DEFAULT_MULTI_API_CONFIG)
  mgr.register(makeEndpoint({ id: "lc-ep" }))
  check("assignLane true for enabled", mgr.assignLane("lc-ep") === true)
  check("assignLane increments laneCount", mgr.snapshot().find((s) => s.id === "lc-ep")!.laneCount === 1)
  mgr.assignLane("lc-ep")
  check("assignLane increments again", mgr.snapshot().find((s) => s.id === "lc-ep")!.laneCount === 2)
  mgr.resetLaneCounts()
  check("resetLaneCounts zeroes", mgr.snapshot().find((s) => s.id === "lc-ep")!.laneCount === 0)
  check("assignLane false for unknown id", mgr.assignLane("nope") === false)
}

// ---- intelligenceToTier ----
{
  check("intelligenceToTier economy 0.1", intelligenceToTier(0.1) === "economy")
  check("intelligenceToTier standard 0.55", intelligenceToTier(0.55) === "standard")
  check("intelligenceToTier premium 0.8", intelligenceToTier(0.8) === "premium")
  check("intelligenceToTier frontier 0.95", intelligenceToTier(0.95) === "frontier")
  check("intelligenceToTier clamps >1", intelligenceToTier(1.5) === "frontier")
  check("intelligenceToTier clamps <0", intelligenceToTier(-0.5) === "economy")
  // boundary: exactly 0.45 -> standard (t >= min for standard tier)
  check("intelligenceToTier boundary 0.45 standard", intelligenceToTier(0.45) === "standard")
  // just below 0.45 is economy
  check("intelligenceToTier boundary 0.44 economy", intelligenceToTier(0.44) === "economy")
  // boundary: exactly 0.70 -> premium
  check("intelligenceToTier boundary 0.7 premium", intelligenceToTier(0.7) === "premium")
  // just below 0.70 is standard
  check("intelligenceToTier boundary 0.69 standard", intelligenceToTier(0.69) === "standard")
}

// ---- estimateCost ----
{
  check("estimateCost economy 10s = 5", estimateCost("economy", 10) === 5)
  check("estimateCost standard 10s = 10", estimateCost("standard", 10) === 10)
  check("estimateCost premium 10s = 20", estimateCost("premium", 10) === 20)
  check("estimateCost frontier 10s = 50", estimateCost("frontier", 10) === 50)
}

// ---- MODEL_TIER_PROFILES ----
{
  check("MODEL_TIER_PROFILES has 4 tiers", MODEL_TIER_PROFILES.length === 4)
  const tiers = MODEL_TIER_PROFILES.map((p) => p.tier)
  check("tiers are economy/standard/premium/frontier", tiers.join(",") === "economy,standard,premium,frontier")
  const economy = MODEL_TIER_PROFILES.find((p) => p.tier === "economy")!
  check("economy costMultiplier 0.5", economy.costMultiplier === 0.5)
  const frontier = MODEL_TIER_PROFILES.find((p) => p.tier === "frontier")!
  check("frontier costMultiplier 5.0", frontier.costMultiplier === 5.0)
}

// ---- DEFAULT_MULTI_API_CONFIG ----
{
  check("default config has 1 endpoint", DEFAULT_MULTI_API_CONFIG.endpoints.length === 1)
  check("default endpoint opencode-default", DEFAULT_MULTI_API_CONFIG.endpoints[0].id === "opencode-default")
  check("default provider opencode", DEFAULT_MULTI_API_CONFIG.defaultProvider === "opencode")
  check("default failover true", DEFAULT_MULTI_API_CONFIG.failover === true)
}

console.log(`\nmulti-api.test.ts: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
