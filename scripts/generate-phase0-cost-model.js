#!/usr/bin/env node

import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const DEFAULT_USER_COUNTS = [200, 500, 1000, 2000];

function parseArgs(argv) {
  const args = {
    baseline: null,
    assumptions: null,
    out: null,
    users: DEFAULT_USER_COUNTS,
  };

  for (const arg of argv) {
    if (arg.startsWith('--baseline=')) {
      args.baseline = arg.slice('--baseline='.length);
    } else if (arg.startsWith('--assumptions=')) {
      args.assumptions = arg.slice('--assumptions='.length);
    } else if (arg.startsWith('--out=')) {
      args.out = arg.slice('--out='.length);
    } else if (arg.startsWith('--users=')) {
      const parsed = arg.slice('--users='.length)
        .split(',')
        .map((value) => Number.parseInt(value.trim(), 10))
        .filter((value) => Number.isFinite(value) && value > 0);
      if (parsed.length > 0) args.users = parsed;
    }
  }

  return args;
}

async function readJson(path, fallback = {}) {
  if (!path) return fallback;
  return JSON.parse(await fs.readFile(path, 'utf8'));
}

function firstMetricRow(baseline, metricName) {
  return baseline?.metrics?.find((metric) => metric.name === metricName)?.rows?.[0] || null;
}

function numberValue(value, fallback = null) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function requiredAssumptionKeys() {
  return [
    'avgConnectedMinutes',
    'callsPerSeniorPerMonth',
    'telnyxPerMinuteUsd',
    'deepgramPerMinuteUsd',
    'ttsCharsPerMinute',
    'ttsPerThousandCharsUsd',
    'anthropicInputTokensPerMinute',
    'anthropicOutputTokensPerMinute',
    'anthropicCacheReadTokensPerMinute',
    'anthropicInputPerMillionTokensUsd',
    'anthropicOutputPerMillionTokensUsd',
    'anthropicCacheReadPerMillionTokensUsd',
    'openAiEmbeddingPerCallUsd',
    'tavilySearchesPerCall',
    'tavilyPerSearchUsd',
    'railwayMonthlyUsd',
    'neonMonthlyUsd',
    'redisMonthlyUsd',
    'sentryMonthlyUsd',
  ];
}

function buildResolvedAssumptions(baseline, rawAssumptions) {
  const duration = firstMetricRow(baseline, 'connected_call_duration_seconds');
  const avgConnectedMinutes = numberValue(rawAssumptions.avgConnectedMinutes)
    ?? (numberValue(duration?.avg_seconds) ? numberValue(duration.avg_seconds) / 60 : null);

  return {
    ...rawAssumptions,
    avgConnectedMinutes,
    callsPerSeniorPerMonth: numberValue(rawAssumptions.callsPerSeniorPerMonth, 30),
  };
}

function computeVariableCostPerCall(assumptions) {
  const missing = requiredAssumptionKeys().filter((key) => assumptions[key] == null || assumptions[key] === '');
  if (missing.length > 0) {
    return { cost: null, missing };
  }

  const minutes = numberValue(assumptions.avgConnectedMinutes, 0);
  const ttsCost = (minutes * assumptions.ttsCharsPerMinute / 1000) * assumptions.ttsPerThousandCharsUsd;
  const inputCost = (minutes * assumptions.anthropicInputTokensPerMinute / 1_000_000) * assumptions.anthropicInputPerMillionTokensUsd;
  const outputCost = (minutes * assumptions.anthropicOutputTokensPerMinute / 1_000_000) * assumptions.anthropicOutputPerMillionTokensUsd;
  const cacheReadCost = (minutes * assumptions.anthropicCacheReadTokensPerMinute / 1_000_000) * assumptions.anthropicCacheReadPerMillionTokensUsd;
  const searchCost = assumptions.tavilySearchesPerCall * assumptions.tavilyPerSearchUsd;

  return {
    missing: [],
    cost:
      minutes * assumptions.telnyxPerMinuteUsd +
      minutes * assumptions.deepgramPerMinuteUsd +
      ttsCost +
      inputCost +
      outputCost +
      cacheReadCost +
      assumptions.openAiEmbeddingPerCallUsd +
      searchCost,
  };
}

function buildCostModel({ baseline = {}, assumptions = {}, users = DEFAULT_USER_COUNTS }) {
  const resolved = buildResolvedAssumptions(baseline, assumptions);
  const variable = computeVariableCostPerCall(resolved);
  const fixedMonthly =
    numberValue(resolved.railwayMonthlyUsd, 0) +
    numberValue(resolved.neonMonthlyUsd, 0) +
    numberValue(resolved.redisMonthlyUsd, 0) +
    numberValue(resolved.sentryMonthlyUsd, 0);

  const rows = users.map((activeSeniors) => {
    const monthlyCalls = activeSeniors * numberValue(resolved.callsPerSeniorPerMonth, 30);
    const variableMonthlyUsd = variable.cost == null ? null : monthlyCalls * variable.cost;
    const totalMonthlyUsd = variableMonthlyUsd == null ? null : variableMonthlyUsd + fixedMonthly;
    return {
      activeSeniors,
      monthlyCalls,
      variableCostPerCallUsd: variable.cost == null ? null : Number(variable.cost.toFixed(4)),
      variableMonthlyUsd: variableMonthlyUsd == null ? null : Number(variableMonthlyUsd.toFixed(2)),
      fixedMonthlyUsd: Number(fixedMonthly.toFixed(2)),
      totalMonthlyUsd: totalMonthlyUsd == null ? null : Number(totalMonthlyUsd.toFixed(2)),
      costPerSeniorPerMonthUsd: totalMonthlyUsd == null ? null : Number((totalMonthlyUsd / activeSeniors).toFixed(2)),
    };
  });

  return {
    generatedAt: new Date().toISOString(),
    sourceBaselineGeneratedAt: baseline.generatedAt || null,
    phiPolicy: {
      outputContainsRawPhi: false,
      notes: 'Uses aggregate baseline metrics and manually entered vendor unit costs only.',
    },
    missingAssumptions: variable.missing,
    assumptions: resolved,
    rows,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const baseline = await readJson(args.baseline, {});
  const assumptions = await readJson(args.assumptions, {});
  const model = buildCostModel({ baseline, assumptions, users: args.users });
  const output = `${JSON.stringify(model, null, 2)}\n`;

  if (args.out) {
    await fs.writeFile(args.out, output, 'utf8');
  } else {
    process.stdout.write(output);
  }

  process.exit(model.missingAssumptions.length > 0 ? 1 : 0);
}

export { buildCostModel, parseArgs };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(JSON.stringify({
      ok: false,
      error: String(error?.message || error).slice(0, 240),
    }, null, 2));
    process.exit(1);
  });
}
