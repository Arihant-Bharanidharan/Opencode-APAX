/**
 * Multi-API management for opencode-swarm-lite v2.1.
 *
 * Registers multiple API endpoints/providers, tracks per-endpoint rate
 * limits and circuit-breaker health, and load-balances lanes across APIs
 * hosting the same model. No real HTTP calls are made here -- this is the
 * control plane that decides which endpoint + model each lane deploys to.
 *
 * Copyright (c) 2026 Arihant Bharanidharan <arihantbharani@outlook.com>
 * SPDX-License-Identifier: MIT
 */

import type { ApiEndpoint, ModelTier, ModelTierProfile, MultiApiConfig } from "./types.js"
import { clamp, round } from "./util.js"

interface EndpointHealth {
  state: "closed" | "open" | "half_open"
  failures: number
  opens: number
  openedAt: number
  cooldownMs: number
  lastFailureAt?: number
  lastSuccessAt?: number
  recoveryCount: number
  /** Tokens remaining in the token bucket. */
  tokens: number
  lastRefill: number
}

interface EndpointRecord {
  endpoint: ApiEndpoint
  health: EndpointHealth
  laneCount: number // lanes currently assigned to this endpoint (this plan)
}

const freshEndpointHealth = (ep: ApiEndpoint): EndpointHealth => ({
  state: "closed",
  failures: 0,
  opens: 0,
  openedAt: 0,
  cooldownMs: 60_000,
  recoveryCount: 0,
  tokens: ep.burst,
  lastRefill: Date.now(),
})

export class MultiApiManager {
  private endpoints: Map<string, ApiEndpoint> = new Map()
  private health: Map<string, EndpointRecord> = new Map()
  private defaultProvider: string
  private loadBalancing: MultiApiConfig["loadBalancing"]
  private failover: boolean
  private now: () => number

  constructor(config: MultiApiConfig, now?: () => number) {
    this.defaultProvider = config.defaultProvider
    this.loadBalancing = config.loadBalancing ?? "round_robin"
    this.failover = config.failover !== false
    this.now = now ?? (() => Date.now())

    for (const ep of config.endpoints) {
      if (!ep.id || !ep.models.length) continue
      this.endpoints.set(ep.id, { ...ep, enabled: ep.enabled !== false })
      this.health.set(ep.id, {
        endpoint: { ...ep, enabled: ep.enabled !== false },
        health: freshEndpointHealth(ep),
        laneCount: 0,
      })
    }
  }

  /** Register or update an API endpoint. */
  register(endpoint: ApiEndpoint): void {
    const existing = this.endpoints.get(endpoint.id)
    this.endpoints.set(endpoint.id, { ...endpoint, enabled: endpoint.enabled !== false })
    if (!existing) {
      this.health.set(endpoint.id, {
        endpoint: { ...endpoint, enabled: endpoint.enabled !== false },
        health: freshEndpointHealth(endpoint),
        laneCount: 0,
      })
    } else {
      const rec = this.health.get(endpoint.id)!
      rec.endpoint = { ...endpoint, enabled: endpoint.enabled !== false }
    }
  }

  /** Remove an endpoint by ID. */
  unregister(id: string): boolean {
    return this.endpoints.delete(id) && this.health.delete(id)
  }

  /** List all registered endpoints. */
  listEndpoints(): ApiEndpoint[] {
    return Array.from(this.endpoints.values())
  }

  /** Get a single endpoint by ID. */
  getEndpoint(id: string): ApiEndpoint | undefined {
    return this.endpoints.get(id)
  }

  /** Enable/disable an endpoint. */
  setEnabled(id: string, enabled: boolean): boolean {
    const ep = this.endpoints.get(id)
    if (!ep) return false
    ep.enabled = enabled
    const rec = this.health.get(id)
    if (rec) rec.endpoint.enabled = enabled
    return true
  }

  /** Reset per-plan lane counts (call before each deployment plan). */
  resetLaneCounts(): void {
    for (const rec of this.health.values()) rec.laneCount = 0
  }

  /** Record a lane assigned to an endpoint (increments lane count). */
  assignLane(endpointId: string): boolean {
    const rec = this.health.get(endpointId)
    if (!rec || !rec.endpoint.enabled) return false
    rec.laneCount += 1
    return true
  }

  /** Circuit-breaker style: record success/failure for an endpoint. */
  record(endpointId: string, kind: "ok" | "429" | "timeout" | "error"): void {
    const rec = this.health.get(endpointId)
    if (!rec) return
    const h = rec.health
    const now = this.now()
    if (kind === "ok") {
      h.state = "closed"
      h.failures = 0
      h.opens = 0
      h.lastSuccessAt = now
      return
    }
    h.failures += kind === "timeout" ? 1.5 : 1
    h.lastFailureAt = now
    const threshold = kind === "timeout" ? 2 : 3
    if (h.state === "half_open" || h.failures >= threshold) {
      h.state = "open"
      h.opens += 1
      h.openedAt = now
      h.cooldownMs = 60_000 * Math.pow(2, Math.min(Math.max(0, h.opens - 1), 3))
    }
  }

  /** Check if an endpoint is currently allowed (circuit not open, or cooldown elapsed). */
  isAllowed(endpointId: string): boolean {
    const rec = this.health.get(endpointId)
    if (!rec || !rec.endpoint.enabled) return false
    const h = rec.health
    if (h.state === "open") {
      if (this.now() - h.openedAt >= h.cooldownMs) {
        h.state = "half_open"
        return true
      }
      return false
    }
    return true // closed or half_open
  }

  /** Consume a rate-limit token from an endpoint's bucket. Returns retryMs or null. */
  consumeToken(endpointId: string): number | null {
    const rec = this.health.get(endpointId)
    if (!rec) return null
    const h = rec.health
    const ep = rec.endpoint
    const now = this.now()
    const elapsed = Math.max(0, (now - h.lastRefill) / 1000)
    h.tokens = Math.max(0, Math.min(ep.burst, h.tokens + elapsed * ep.rateLimitPerSecond))
    h.lastRefill = now
    if (h.tokens >= 1) {
      h.tokens -= 1
      return null
    }
    return Math.ceil(((1 - h.tokens) / ep.rateLimitPerSecond) * 1000)
  }

  /** Select the best endpoint for a given model, considering health, rate limits, and load balancing. */
  selectEndpoint(
    model: string,
    exclude: string[] = [],
    prefer: string[] = [],
  ): { endpointId: string; endpoint: ApiEndpoint; retryMs?: number } | null {
    const candidates: Array<{ id: string; ep: ApiEndpoint; score: number; retryMs?: number }> = []

    for (const [id, rec] of this.health) {
      const ep = rec.endpoint
      if (!ep.enabled) continue
      if (!ep.models.includes(model)) continue
      if (exclude.includes(id)) continue
      if (!this.isAllowed(id)) continue

      const retryMs = this.consumeToken(id)
      if (retryMs !== null) {
        // endpoint is rate-limited; note it but don't use unless failover allows
        candidates.push({ id, ep, score: -1, retryMs })
        continue
      }

      let score = 0
      // Preference order
      const prefIdx = prefer.indexOf(id)
      if (prefIdx >= 0) score += 100 - prefIdx * 10
      // Lower lane count = better load balance
      score -= rec.laneCount * 5
      // Reliability bonus
      if (rec.health.state === "closed") score += 10
      else if (rec.health.state === "half_open") score += 3
      // Cost preference: cheaper endpoints score slightly higher
      score += (3 - ep.costTier) * 2
      // Intelligence preference
      score += ep.intelligence * 5

      candidates.push({ id, ep, score })
    }

    if (candidates.length === 0) return null

    // Sort by score descending; if top candidate is rate-limited, check failover
    candidates.sort((a, b) => b.score - a.score)
    const best = candidates[0]!
    if (best.retryMs !== undefined && this.failover) {
      // Try next non-rate-limited candidate
      const fallback = candidates.find((c) => c.retryMs === undefined)
      if (fallback) return { endpointId: fallback.id, endpoint: fallback.ep }
      return { endpointId: best.id, endpoint: best.ep, retryMs: best.retryMs }
    }
    return { endpointId: best.id, endpoint: best.ep }
  }

  /** Get endpoints that host a given model and are currently healthy. */
  endpointsForModel(model: string): ApiEndpoint[] {
    return Array.from(this.endpoints.values()).filter(
      (ep) => ep.enabled && ep.models.includes(model) && this.isAllowed(ep.id),
    )
  }

  /** Snapshot of endpoint health for status reporting. */
  snapshot(): Array<{
    id: string
    name: string
    provider: string
    models: string[]
    enabled: boolean
    state: string
    laneCount: number
    failures: number
    cooldownRemaining: number
  }> {
    return Array.from(this.health.values()).map((rec) => {
      const h = rec.health
      const ep = rec.endpoint
      let state = h.state
      if (h.state === "open" && this.now() - h.openedAt >= h.cooldownMs) state = "half_open"
      return {
        id: ep.id,
        name: ep.name,
        provider: ep.provider,
        models: ep.models,
        enabled: ep.enabled,
        state,
        laneCount: rec.laneCount,
        failures: h.failures,
        cooldownRemaining: h.state === "open" ? Math.max(0, Math.ceil((h.openedAt + h.cooldownMs - this.now()) / 1000)) : 0,
      }
    })
  }

  getDefaultProvider(): string {
    return this.defaultProvider
  }
}

function nowMs(): number {
  return Date.now()
}

/** Default multi-API config: single opencode endpoint (backward compatible with v2). */
export const DEFAULT_MULTI_API_CONFIG: MultiApiConfig = {
  endpoints: [
    {
      id: "opencode-default",
      name: "OpenCode Default",
      provider: "opencode",
      baseUrl: "https://api.opencode.com",
      apiKeyEnv: "OPENCODE_API_KEY",
      models: ["mimo-v2.6-flash-free"],
      rateLimitPerSecond: 4,
      burst: 8,
      costTier: 0,
      intelligence: 0.66,
      enabled: true,
    },
  ],
  defaultProvider: "opencode",
  loadBalancing: "round_robin",
  failover: true,
}

/** Model tier profiles used by the feature router. */
export const MODEL_TIER_PROFILES: ModelTierProfile[] = [
  {
    tier: "economy",
    models: ["mimo-v2.6-flash-free"],
    minIntelligence: 0.0,
    maxIntelligence: 0.45,
    costMultiplier: 0.5,
    speedMultiplier: 1.4,
  },
  {
    tier: "standard",
    models: ["mimo-v2.6-flash-free"],
    minIntelligence: 0.45,
    maxIntelligence: 0.70,
    costMultiplier: 1.0,
    speedMultiplier: 1.0,
  },
  {
    tier: "premium",
    models: ["mimo-v2.6-flash-free"],
    minIntelligence: 0.70,
    maxIntelligence: 0.90,
    costMultiplier: 2.0,
    speedMultiplier: 0.8,
  },
  {
    tier: "frontier",
    models: ["mimo-v2.6-flash-free"],
    minIntelligence: 0.90,
    maxIntelligence: 1.0,
    costMultiplier: 5.0,
    speedMultiplier: 0.5,
  },
]

/** Map an intelligence score (0..1) to a model tier. */
export function intelligenceToTier(intelligence: number): ModelTier {
  const t = clamp(intelligence, 0, 1)
  for (const profile of MODEL_TIER_PROFILES) {
    if (t >= profile.minIntelligence && t < profile.maxIntelligence) return profile.tier
  }
  return "frontier"
}

/** Estimate cost for a lane given tier and expected seconds. */
export function estimateCost(tier: ModelTier, seconds: number): number {
  const profile = MODEL_TIER_PROFILES.find((p) => p.tier === tier)
  const mult = profile?.costMultiplier ?? 1
  return round(seconds * mult, 2)
}
