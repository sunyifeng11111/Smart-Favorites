import { readFile, writeFile } from 'node:fs/promises';
import process from 'node:process';

import { HttpJevClient } from '../src/adapters/jev-client';
import {
  runEvaluationSet,
  validateEvaluationSet,
  type EvaluationCase,
} from '../src/evaluation/evaluation';
import { BETA_GATE_THRESHOLDS, evaluateBetaGate } from '../src/evaluation/release-gate';

const args = process.argv.slice(2);
const supportedFlags = new Set(['--require-beta-gate']);
const unknownFlag = args.find((argument) => argument.startsWith('--') && !supportedFlags.has(argument));
if (unknownFlag) throw new Error(`Unknown option: ${unknownFlag}`);
const requireBetaGate = args.includes('--require-beta-gate');
const [datasetPath, outputPath] = args.filter((argument) => !argument.startsWith('--'));
if (!datasetPath) {
  throw new Error(
    'Usage: pnpm evaluate[:gate] <dataset.json> [metrics-report.json]',
  );
}
const apiKey = process.env.JEV_API_KEY?.trim();
if (!apiKey) throw new Error('Set JEV_API_KEY before running an evaluation');

const parsed: unknown = JSON.parse(await readFile(datasetPath, 'utf8'));
validateEvaluationSet(parsed);
const cases: EvaluationCase[] = parsed;
const client = new HttpJevClient();
const { report } = await runEvaluationSet(cases, async (request) => {
  const result = await client.classify(request, apiKey);
  return {
    choice: result.choice,
    confidence: result.confidence,
    probabilities: result.probabilities,
  };
});
const betaGate = evaluateBetaGate(report.full);
const metricsReport = JSON.stringify({
  generatedAt: new Date().toISOString(),
  datasetSize: cases.length,
  segments: {
    chinese: report.zh,
    english: report.en,
    overall: report.full,
  },
  betaGate: {
    required: requireBetaGate,
    thresholds: BETA_GATE_THRESHOLDS,
    ...betaGate,
  },
}, null, 2);

if (outputPath) {
  await writeFile(outputPath, `${metricsReport}\n`, 'utf8');
}
process.stdout.write(`${metricsReport}\n`);
if (requireBetaGate && !betaGate.passed) process.exitCode = 1;
