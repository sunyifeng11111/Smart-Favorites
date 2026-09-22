import { readFile, writeFile } from 'node:fs/promises';
import process from 'node:process';

import { HttpJevClient } from '../src/adapters/jev-client';
import {
  runEvaluationSet,
  validateEvaluationSet,
  type EvaluationCase,
} from '../src/evaluation/evaluation';

const [datasetPath, outputPath] = process.argv.slice(2);
if (!datasetPath) {
  throw new Error('Usage: pnpm evaluate <dataset.json> [metrics-report.json]');
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
const metricsReport = JSON.stringify({
  generatedAt: new Date().toISOString(),
  datasetSize: cases.length,
  metrics: report,
}, null, 2);

if (outputPath) {
  await writeFile(outputPath, `${metricsReport}\n`, 'utf8');
} else {
  process.stdout.write(`${metricsReport}\n`);
}
