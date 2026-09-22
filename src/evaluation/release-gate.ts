import type { EvaluationMetrics } from './evaluation';

export const BETA_GATE_THRESHOLDS = {
  top1Accuracy: 0.8,
  top3Accuracy: 0.95,
  automaticSavePrecision: 0.95,
} as const;

export interface BetaGateResult {
  passed: boolean;
  failures: string[];
  automaticSaveCoverage: number;
}

export function evaluateBetaGate(metrics: EvaluationMetrics): BetaGateResult {
  const failures: string[] = [];
  if (metrics.top1Accuracy < BETA_GATE_THRESHOLDS.top1Accuracy) {
    failures.push(
      `Overall Top-1 accuracy ${percent(metrics.top1Accuracy)} is below ${percent(BETA_GATE_THRESHOLDS.top1Accuracy)}`,
    );
  }
  if (metrics.top3Accuracy < BETA_GATE_THRESHOLDS.top3Accuracy) {
    failures.push(
      `Overall Top-3 accuracy ${percent(metrics.top3Accuracy)} is below ${percent(BETA_GATE_THRESHOLDS.top3Accuracy)}`,
    );
  }
  if (metrics.automaticSavePrecision == null) {
    failures.push(
      'Automatic Save Precision is unavailable because no pages qualified for Automatic Save',
    );
  } else if (metrics.automaticSavePrecision < BETA_GATE_THRESHOLDS.automaticSavePrecision) {
    failures.push(
      `Automatic Save Precision ${percent(metrics.automaticSavePrecision)} is below ${percent(BETA_GATE_THRESHOLDS.automaticSavePrecision)}`,
    );
  }
  return {
    passed: failures.length === 0,
    failures,
    automaticSaveCoverage: metrics.automaticSaveCoverage,
  };
}

function percent(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}
