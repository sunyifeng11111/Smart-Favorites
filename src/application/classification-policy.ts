import type { JevClassificationResult } from './types';

export const AUTOMATIC_CONFIDENCE_THRESHOLD = 0.8;
export const AUTOMATIC_OPTION_PROBABILITY_THRESHOLD = 0.7;

export function qualifiesForAutomaticSave(result: JevClassificationResult): boolean {
  return result.confidence >= AUTOMATIC_CONFIDENCE_THRESHOLD &&
    (result.probabilities[result.choice] ?? 0) >= AUTOMATIC_OPTION_PROBABILITY_THRESHOLD;
}
