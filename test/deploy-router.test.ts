/**
 * Tests for deploy-router (v2.1 deployment planner).
 *
 * Verifies per-lane model/API/tier assignment for both semi_adaptive and
 * full_adaptive modes, cost budget enforcement, warnings for unassigned lanes,
 * lane count derivation, and routerPolicyFromInput.
 *
 * Follows the check() + process.exit(fail === 0 ? 0 : 1) convention.
 *
 * Copyright (c) 2026 Arihant Bharanidharan <arihantbharani@outlook.com>
 * SPDX-License-Identifier: MIT
 */

import { createDeploymentPlan, defaultMultiApiConfig, routerPolicyFromInput } from "../src/runtime/deploy-router.js"
import { MultiApiManager } from "../src/runtime/multi-api.js"
import type { ApiEndpoint, TaskInput } from "../src/runtime/types.js"

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

function mgrWith(endpoints: ApiEndpoint[]): MultiApiManager {
  return new MultiApiManager({ ...defaultMultiApiConfig(endpoints), failover: true })
}

// Helper for "no healthy endpoint" test: manager with ONLY disabled endpoints (skip defaultMultiApiConfig prepending)
function mgrOnly(endpoints: ApiEndpoint[]): MultiApiManager {
  return new MultiApiManager({ endpoints, defaultProvider: "opencode", loadBalancing: "round_robin", failover: true })
}

const baseInput: TaskInput = {
  task: "refactor three small modules",
  category: "coding",
  branchSeconds: 30,
}

// ---- semi_adaptive: every lane parent model; multiple APIs for headroom ----
{
  const mgr = mgrWith([
    { id: "ep-a", name: "EP A", provider: "prov-a", baseUrl: "https://a.example", apiKeyEnv: "A_KEY", models: ["mimo-v2.6-flash-free"], rateLimitPerSecond: 4, burst: 8, costTier: 0, intelligence: 0.66, enabled: true },
    { id: "ep-b", name: "EP B", provider: "prov-b", baseUrl: "https://b.example", apiKeyEnv: "B_KEY", models: ["mimo-v2.6-flash-free"], rateLimitPerSecond: 4, burst: 8, costTier: 0, intelligence: 0.66, enabled: true },
  ])
  const plan = createDeploymentPlan({ ...baseInput, branches: 3, deploymentMode: "semi_adaptive" }, mgr)

  check("semi_adaptive plan mode", plan.mode === "semi_adaptive")
  check("semi_adaptive parent model", plan.parentModel === "mimo-v2.6-flash-free")
  check("semi_adaptive 3 lanes", plan.deployments.length === 3, `count=${plan.deployments.length}`)
  check("all lanes parent model", plan.deployments.every((d) => d.model === "mimo-v2.6-flash-free"))
  check("all lanes modelTier standard", plan.deployments.every((d) => d.modelTier === "standard"))
  check("lanes distributed across APIs", new Set(plan.deployments.map((d) => d.apiEndpointId)).size >= 1)
  check("apiUsage sums to lanes", Object.values(plan.apiUsage).reduce((a, b) => a + b, 0) === 3, JSON.stringify(plan.apiUsage))
  check("reasons mention semi_adaptive", plan.reasons.some((r) => /semi_adaptive/.test(r)))
  check("no warnings when healthy", plan.warnings.length === 0, JSON.stringify(plan.warnings))
}

// ---- full_adaptive: router picks tier/model per lane ----
{
  const mgr = mgrWith([
    { id: "ep-a", name: "EP A", provider: "prov-a", baseUrl: "https://a.example", apiKeyEnv: "A_KEY", models: ["mimo-v2.6-flash-free"], rateLimitPerSecond: 4, burst: 8, costTier: 0, intelligence: 0.66, enabled: true },
  ])
  const plan = createDeploymentPlan({ ...baseInput, branches: 3, deploymentMode: "full_adaptive", intelligence: 0.85 }, mgr)

  check("full_adaptive plan mode", plan.mode === "full_adaptive")
  check("full_adaptive lanes assigned", plan.deployments.length === 3, `count=${plan.deployments.length}`)
  check("full_adaptive tier premium", plan.deployments.every((d) => d.modelTier === "premium"), `tiers=${plan.deployments.map((d) => d.modelTier).join(",")}`)
  check("reasons mention full_adaptive", plan.reasons.some((r) => /full_adaptive/.test(r)))
  check("totalEstimatedCost > 0", plan.totalEstimatedCost > 0, `cost=${plan.totalEstimatedCost}`)
}

// ---- cost budget enforcement ----
{
  const mgr = mgrWith([
    { id: "ep-a", name: "EP A", provider: "prov-a", baseUrl: "https://a.example", apiKeyEnv: "A_KEY", models: ["mimo-v2.6-flash-free"], rateLimitPerSecond: 4, burst: 8, costTier: 3, intelligence: 0.95, enabled: true },
  ])
  // frontier tier costMultiplier 5.0; seconds=30 => 150 per lane; budget 100 => only first lane fits
  const plan = createDeploymentPlan({ ...baseInput, branches: 3, deploymentMode: "full_adaptive", intelligence: 0.95, costBudget: 100 }, mgr)

  check("cost budget limits lanes", plan.deployments.length < 3, `count=${plan.deployments.length}`)
  check("budget exhausted warning", plan.warnings.some((w) => /cost budget/.test(w)), JSON.stringify(plan.warnings))
  check("totalEstimatedCost within budget", plan.totalEstimatedCost <= 100, `cost=${plan.totalEstimatedCost}`)
}

// ---- unassigned lanes when no healthy API ----
{
  // Create manager with ONLY disabled endpoints (skip defaultMultiApiConfig prepending)
  const mgr = mgrOnly([
    { id: "ep-dead", name: "EP Dead", provider: "prov-dead", baseUrl: "https://dead.example", apiKeyEnv: "D_KEY", models: ["mimo-v2.6-flash-free"], rateLimitPerSecond: 4, burst: 8, costTier: 0, intelligence: 0.5, enabled: false },
  ])
  const plan = createDeploymentPlan({ ...baseInput, branches: 3, deploymentMode: "semi_adaptive" }, mgr)

  check("no healthy endpoint => 0 deployments", plan.deployments.length === 0, `count=${plan.deployments.length}`)
  check("warning about unassigned lanes", plan.warnings.some((w) => /unassigned|no healthy/.test(w)), JSON.stringify(plan.warnings))
  check("warning all lanes unassigned", plan.warnings.some((w) => /all lanes unassigned/.test(w)), JSON.stringify(plan.warnings))
}

// ---- apiExclude / apiPrefer ----
{
  const mgr = mgrWith([
    { id: "ep-pref", name: "EP Pref", provider: "prov-p", baseUrl: "https://p.example", apiKeyEnv: "P_KEY", models: ["mimo-v2.6-flash-free"], rateLimitPerSecond: 4, burst: 8, costTier: 0, intelligence: 0.9, enabled: true },
    { id: "ep-other", name: "EP Other", provider: "prov-o", baseUrl: "https://o.example", apiKeyEnv: "O_KEY", models: ["mimo-v2.6-flash-free"], rateLimitPerSecond: 4, burst: 8, costTier: 0, intelligence: 0.5, enabled: true },
  ])
  const plan = createDeploymentPlan({ ...baseInput, branches: 3, deploymentMode: "semi_adaptive", apiPrefer: ["ep-pref"] }, mgr)

  check("apiPrefer routes to preferred endpoint", plan.deployments.every((d) => d.apiEndpointId === "ep-pref"), `ids=${plan.deployments.map((d) => d.apiEndpointId).join(",")}`)
  check("apiUsage concentrated on preferred", plan.apiUsage["ep-pref"] === 3, JSON.stringify(plan.apiUsage))
}

// ---- lane count derivation: branches / tasks / nodes default 1 ----
{
  const mgr = mgrWith([{ id: "ep-a", name: "EP A", provider: "prov-a", baseUrl: "https://a.example", apiKeyEnv: "A_KEY", models: ["mimo-v2.6-flash-free"], rateLimitPerSecond: 4, burst: 8, costTier: 0, intelligence: 0.66, enabled: true }])

  const p1 = createDeploymentPlan({ ...baseInput, branches: 0 }, mgr)
  check("branches 0 => 1 lane", p1.deployments.length === 1)

  const p2 = createDeploymentPlan({ ...baseInput, branches: 5, branchSeconds: 20 }, mgr)
  check("branches 5 => 5 lanes", p2.deployments.length === 5, `count=${p2.deployments.length}`)

  // Note: explicitly set branches: undefined to avoid shadow by baseInput
  const p3 = createDeploymentPlan({ ...baseInput, branches: undefined, tasks: [{ id: "t1", seconds: 10 }, { id: "t2", seconds: 20 }] }, mgr)
  check("tasks length => 2 lanes", p3.deployments.length === 2, `count=${p3.deployments.length}`)

  const p4 = createDeploymentPlan({ ...baseInput, branches: undefined, tasks: undefined, nodes: undefined }, mgr)
  check("no fanout hints => 1 lane", p4.deployments.length === 1)
}

// ---- default runId when omitted ----
{
  const mgr = mgrWith([{ id: "ep-a", name: "EP A", provider: "prov-a", baseUrl: "https://a.example", apiKeyEnv: "A_KEY", models: ["mimo-v2.6-flash-free"], rateLimitPerSecond: 4, burst: 8, costTier: 0, intelligence: 0.66, enabled: true }])
  const plan = createDeploymentPlan(baseInput, mgr)
  check("runId starts with deploy-", /^deploy-/.test(plan.runId), `runId=${plan.runId}`)
}

// ---- routerPolicyFromInput ----
{
  const p = routerPolicyFromInput({ ...baseInput, deploymentMode: "full_adaptive", model: "mimo-v2.6-reasoning", intelligence: 0.8, costBudget: 50 })
  check("policy mode full_adaptive", p.mode === "full_adaptive")
  check("policy parentModel", p.parentModel === "mimo-v2.6-reasoning")
  check("policy intelligenceThreshold", p.intelligenceThreshold === 0.8)
  check("policy costBudgetSeconds", p.costBudgetSeconds === 50)

  const p2 = routerPolicyFromInput(baseInput)
  check("default mode semi_adaptive", p2.mode === "semi_adaptive")
  check("default parentModel", p2.parentModel === "mimo-v2.6-flash-free")
  check("default intelligenceThreshold 0.7", p2.intelligenceThreshold === 0.7)
}

console.log(`\ndeploy-router.test.ts: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
