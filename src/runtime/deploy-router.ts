/**
 * Deployment router / planner for opencode-apax v2.2.
 *
 * Takes a TaskInput + MultiApiManager and returns a DeploymentPlan with
 * per-lane model/API/tier assignments. Two deployment modes:
 *   - semi_adaptive : every lane uses the parent model; multiple APIs are
 *                     used only to raise rate-limit headroom.
 *   - full_adaptive : the router decides model + API per lane from task
 *                     features (intelligence vs cost trade-off).
 *
 * No real HTTP calls are made here -- this is the control plane.
 *
 * Copyright (c) 2026 Arihant Bharanidharan <arihantbharani@outlook.com>
 * SPDX-License-Identifier: MIT
 */

import type {
  ApiEndpoint,
  Category,
  DeploymentMode,
  DeploymentPlan,
  LaneDeployment,
  ModelTier,
  MultiApiConfig,
  RouterPolicy,
  TaskInput,
} from "./types.js"
import { MultiApiManager, estimateCost, intelligenceToTier } from "./multi-api.js"
import { round } from "./util.js"

const DEFAULT_RUN_ID_PREFIX = "deploy-"

const DEFAULT_ROUTER_POLICY: RouterPolicy = {
  mode: "semi_adaptive",
  parentModel: "mimo-v2.6-flash-free",
  intelligenceThreshold: 0.7,
  preferCheap: false,
  maxConcurrentPerApi: 8,
}

/** Category -> default specialist role hint. */
const CATEGORY_ROLE: Record<Category, string> = {
  microtask: "builder",
  research: "researcher",
  coding: "coder",
  analysis: "analyst",
  verification: "verifier",
  mixed: "builder",
  ops: "builder",
}

/** Derive a lane count from TaskInput. Defaults to 1 (never fan out by default). */
function laneCountFromInput(input: TaskInput): number {
  if (input.branches !== undefined && Number.isFinite(input.branches) && input.branches >= 1) {
    return Math.min(Math.max(Math.round(input.branches), 1), 64)
  }
  if (input.tasks && input.tasks.length > 0) return Math.min(input.tasks.length, 64)
  if (input.nodes && input.nodes.length > 0) return Math.min(input.nodes.length, 64)
  return 1
}

/** Map a TaskInput category to a lane role. */
function roleForCategory(category: Category | undefined): string {
  return category ? CATEGORY_ROLE[category] : "builder"
}

/** Estimate expected seconds for a lane. */
function laneSeconds(input: TaskInput): number {
  if (typeof input.branchSeconds === "number" && Number.isFinite(input.branchSeconds) && input.branchSeconds > 0) {
    return input.branchSeconds
  }
  if (input.tasks && input.tasks.length > 0) {
    return round(input.tasks.reduce((sum, t) => sum + t.seconds, 0) / Math.max(1, input.tasks.length), 1)
  }
  return 30 // default 30s per lane
}

/** Required intelligence (0..1) for this task. Defaults to standard tier (0.55). */
function requiredIntelligence(input: TaskInput): number {
  const v = input.intelligence
  if (typeof v === "number" && Number.isFinite(v)) return round(Math.min(Math.max(v, 0), 1), 2)
  // Infer from category/ambiguity/risk when not given
  let score = 0.55
  if (input.category === "analysis" || input.category === "research") score += 0.1
  if (input.ambiguity !== undefined) score += input.ambiguity * 0.15
  if (input.risk !== undefined) score += input.risk * 0.1
  return round(Math.min(Math.max(score, 0), 1), 2)
}

/** Pick a model tier + model for the required intelligence under a policy. */
function pickTierAndModel(
  intelligence: number,
  policy: RouterPolicy,
  apiManager: MultiApiManager,
  apiPrefer: string[],
): { tier: ModelTier; model: string } | null {
  const tier = intelligenceToTier(intelligence)
  const profile: Record<ModelTier, { models: string[]; minIntelligence: number; maxIntelligence: number }> = {
    economy: { models: ["mimo-v2.6-flash-free"], minIntelligence: 0, maxIntelligence: 0.45 },
    standard: { models: ["mimo-v2.6-flash-free"], minIntelligence: 0.45, maxIntelligence: 0.7 },
    premium: { models: ["mimo-v2.6-flash-free"], minIntelligence: 0.7, maxIntelligence: 0.9 },
    frontier: { models: ["mimo-v2.6-flash-free"], minIntelligence: 0.9, maxIntelligence: 1.0 },
  }
  const models = profile[tier].models
  // In semi_adaptive mode, always use the parent model regardless of tier.
  if (policy.mode === "semi_adaptive") {
    return { tier, model: policy.parentModel }
  }
  // Full adaptive: prefer a model hosted on a preferred/healthy endpoint.
  for (const pref of apiPrefer) {
    const ep = apiManager.getEndpoint(pref)
    if (ep && ep.models.some((m) => models.includes(m))) {
      return { tier, model: models[0] }
    }
  }
  return { tier, model: models[0] }
}

/** Select an API endpoint for a model, respecting exclusions/preferences. */
function selectApiForModel(
  apiManager: MultiApiManager,
  model: string,
  exclude: string[],
  prefer: string[],
): { endpointId: string; endpoint: ApiEndpoint; retryMs?: number } | null {
  return apiManager.selectEndpoint(model, exclude, prefer)
}

/**
 * Build a DeploymentPlan from a TaskInput and MultiApiManager.
 *
 * @param input - task description + v2.1 overrides (deploymentMode, intelligence, costBudget, apiExclude, apiPrefer)
 * @param apiManager - multi-API control plane (caller owns lifecycle)
 * @param runId - optional run id; auto-generated when omitted
 * @param policy - optional router policy overrides (mode, parentModel, thresholds)
 */
export function createDeploymentPlan(
  input: TaskInput,
  apiManager: MultiApiManager,
  runId?: string,
  policy?: Partial<RouterPolicy>,
): DeploymentPlan {
  const mergedPolicy: RouterPolicy = { ...DEFAULT_ROUTER_POLICY, ...policy }
  if (input.deploymentMode !== undefined) mergedPolicy.mode = input.deploymentMode
  if (input.model) mergedPolicy.parentModel = input.model

  const id = runId || `${DEFAULT_RUN_ID_PREFIX}${Date.now()}`
  apiManager.resetLaneCounts()

  const count = laneCountFromInput(input)
  const category = input.category ?? "mixed"
  const role = roleForCategory(category)
  const seconds = laneSeconds(input)
  const intelligence = requiredIntelligence(input)
  const exclude = input.apiExclude ?? []
  const prefer = input.apiPrefer ?? []

  const deployments: LaneDeployment[] = []
  let totalEstimatedCost = 0
  let totalEstimatedIntelligence = 0
  const apiUsage: Record<string, number> = {}
  const reasons: string[] = []
  const warnings: string[] = []

  reasons.push(`mode=${mergedPolicy.mode} lanes=${count} category=${category} role=${role}`)
  reasons.push(`requiredIntelligence=${intelligence} parentModel=${mergedPolicy.parentModel}`)

  if (mergedPolicy.mode === "semi_adaptive") {
    reasons.push(
      `semi_adaptive: every lane uses parent model ${mergedPolicy.parentModel}; multiple APIs only for rate-limit headroom`,
    )
    for (let i = 0; i < count; i++) {
      const laneId = `lane-${i + 1}`
      const selection = selectApiForModel(apiManager, mergedPolicy.parentModel, exclude, prefer)
      if (!selection) {
        warnings.push(`no healthy API endpoint available for ${mergedPolicy.parentModel}; lane ${laneId} unassigned`)
        continue
      }
      apiManager.assignLane(selection.endpointId)
      apiUsage[selection.endpointId] = (apiUsage[selection.endpointId] ?? 0) + 1
      const tier = intelligenceToTier(intelligence)
      const estCost = estimateCost(tier, seconds)
      const estIntel = selection.endpoint.intelligence
      totalEstimatedCost += estCost
      totalEstimatedIntelligence += estIntel
      deployments.push({
        laneId,
        role,
        category,
        model: mergedPolicy.parentModel,
        provider: selection.endpoint.provider,
        apiEndpointId: selection.endpoint.id,
        modelTier: tier,
        reason: `semi_adaptive: parent model on ${selection.endpoint.name} (${selection.endpoint.provider})`,
        estimatedCost: estCost,
        estimatedIntelligence: estIntel,
      })
    }
  } else {
    // full_adaptive: router picks model + API per lane from task features
    const picked = pickTierAndModel(intelligence, mergedPolicy, apiManager, prefer)
    if (!picked) {
      warnings.push(`no model tier available for intelligence=${intelligence}; falling back to parent model`)
      for (let i = 0; i < count; i++) {
        const laneId = `lane-${i + 1}`
        const selection = selectApiForModel(apiManager, mergedPolicy.parentModel, exclude, prefer)
        if (!selection) {
          warnings.push(`no healthy API endpoint available for ${mergedPolicy.parentModel}; lane ${laneId} unassigned`)
          continue
        }
        apiManager.assignLane(selection.endpointId)
        apiUsage[selection.endpointId] = (apiUsage[selection.endpointId] ?? 0) + 1
        const tier = intelligenceToTier(intelligence)
        const estCost = estimateCost(tier, seconds)
        deployments.push({
          laneId,
          role,
          category,
          model: mergedPolicy.parentModel,
          provider: selection.endpoint.provider,
          apiEndpointId: selection.endpoint.id,
          modelTier: tier,
          reason: `full_adaptive fallback: parent model on ${selection.endpoint.name}`,
          estimatedCost: estCost,
          estimatedIntelligence: selection.endpoint.intelligence,
        })
      }
    } else {
      const { tier, model } = picked
      reasons.push(
        `full_adaptive: tier=${tier} model=${model} intelligence=${intelligence} threshold=${mergedPolicy.intelligenceThreshold}`,
      )
      const costBudget = input.costBudget ?? mergedPolicy.costBudgetSeconds
      let budgetRemaining = typeof costBudget === "number" ? costBudget : Infinity
      for (let i = 0; i < count; i++) {
        const laneId = `lane-${i + 1}`
        const selection = selectApiForModel(apiManager, model, exclude, prefer)
        if (!selection) {
          warnings.push(`no healthy API endpoint for ${model}; lane ${laneId} unassigned`)
          continue
        }
        const estCost = estimateCost(tier, seconds)
        if (budgetRemaining !== Infinity && estCost > budgetRemaining) {
          warnings.push(`cost budget exhausted; lane ${laneId} unassigned`)
          break
        }
        apiManager.assignLane(selection.endpointId)
        apiUsage[selection.endpointId] = (apiUsage[selection.endpointId] ?? 0) + 1
        budgetRemaining -= estCost
        const estIntel = selection.endpoint.intelligence
        totalEstimatedCost += estCost
        totalEstimatedIntelligence += estIntel
        deployments.push({
          laneId,
          role,
          category,
          model,
          provider: selection.endpoint.provider,
          apiEndpointId: selection.endpoint.id,
          modelTier: tier,
          reason: `full_adaptive: ${tier} tier (intelligence ${intelligence}) on ${selection.endpoint.name} (${selection.endpoint.provider})`,
          estimatedCost: estCost,
          estimatedIntelligence: estIntel,
        })
      }
    }
  }

  totalEstimatedIntelligence = round(totalEstimatedIntelligence / Math.max(1, deployments.length), 2)
  totalEstimatedCost = round(totalEstimatedCost, 2)

  if (deployments.length === 0 && count > 0) {
    warnings.push("all lanes unassigned: no healthy API endpoint could serve any lane")
  }

  return {
    runId: id,
    mode: mergedPolicy.mode,
    parentModel: mergedPolicy.parentModel,
    deployments,
    totalEstimatedCost,
    totalEstimatedIntelligence,
    apiUsage,
    reasons,
    warnings,
  }
}

/** Create a default MultiApiConfig with the opencode default endpoint plus optional extras. */
export function defaultMultiApiConfig(extraEndpoints: ApiEndpoint[] = []): MultiApiConfig {
  return {
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
      ...extraEndpoints,
    ],
    defaultProvider: "opencode",
    loadBalancing: "round_robin",
    failover: true,
  }
}

/** Create a RouterPolicy from TaskInput v2.1 fields. */
export function routerPolicyFromInput(input: TaskInput): RouterPolicy {
  return {
    mode: input.deploymentMode ?? "semi_adaptive",
    parentModel: input.model ?? "mimo-v2.6-flash-free",
    intelligenceThreshold: typeof input.intelligence === "number" ? input.intelligence : 0.7,
    costBudgetSeconds: input.costBudget,
    preferCheap: false,
    maxConcurrentPerApi: 8,
  }
}
