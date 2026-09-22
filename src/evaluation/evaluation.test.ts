import { describe, expect, it } from 'vitest';

import {
  evaluateClassificationResults,
  validateEvaluationSet,
  type EvaluationCase,
  type EvaluationResult,
} from './evaluation';
import { evaluateBetaGate } from './release-gate';

describe('Evaluation Set runner', () => {
  it('calculates exact-folder Top-1, Top-3, Automatic Save Precision, and Coverage by language', () => {
    const cases = evaluationCases(100);
    const results: EvaluationResult[] = cases.map((item, index) => {
      const correct = index % 4 !== 3;
      const automatic = index < 50;
      return {
        caseId: item.id,
        choice: correct ? item.expectedFolderId : 'folder-wrong',
        confidence: automatic ? 0.9 : 0.6,
        probabilities: correct
          ? { [item.expectedFolderId]: automatic ? 0.8 : 0.45, 'folder-wrong': 0.4 }
          : { 'folder-wrong': automatic ? 0.8 : 0.45, [item.expectedFolderId]: 0.4 },
      };
    });

    const report = evaluateClassificationResults(cases, results);

    expect(report.full).toEqual({
      sampleSize: 100,
      top1Accuracy: 0.75,
      top3Accuracy: 1,
      automaticSavePrecision: 0.76,
      automaticSaveCoverage: 0.5,
    });
    expect(report.zh.sampleSize).toBe(50);
    expect(report.en.sampleSize).toBe(50);
    expect(report.zh.top1Accuracy).toBe(1);
    expect(report.en.top1Accuracy).toBe(0.5);
  });

  it('maps a no-match response to the exact managed Pending Folder identity', () => {
    const cases = evaluationCases(100);
    cases[0] = {
      ...cases[0]!,
      expectedFolderId: 'pending-folder',
      pendingFolderId: 'pending-folder',
    };
    const results = cases.map((item) => ({
      caseId: item.id,
      choice: item.id === 'case-0' ? '__no_match__' : item.expectedFolderId,
      confidence: 0.9,
      probabilities: item.id === 'case-0'
        ? { __no_match__: 0.9, 'folder-wrong': 0.1 }
        : { [item.expectedFolderId]: 0.9 },
    }));

    const report = evaluateClassificationResults(cases, results);

    expect(report.full.top1Accuracy).toBe(1);
    expect(report.full.top3Accuracy).toBe(1);
    expect(report.full.automaticSaveCoverage).toBe(0.99);
  });

  it('requires 100 manually labeled pages and rejects any Evaluation Set page used as a Folder Example', () => {
    const tooSmall = evaluationCases(99);
    expect(() => validateEvaluationSet(tooSmall)).toThrow('at least 100');

    const notManual = evaluationCases(100);
    notManual[0] = { ...notManual[0]!, labelSource: 'imported' as 'manual' };
    expect(() => validateEvaluationSet(notManual)).toThrow('manually labeled');

    const leaked = evaluationCases(100);
    leaked[1]!.eligibleFolders[0]!.examples = [
      { title: 'Leaked evaluation page', domain: 'example.com', sourcePageId: 'case-0' },
    ];
    expect(() => validateEvaluationSet(leaked)).toThrow('held out');

    const spoofed = evaluationCases(100);
    spoofed[1]!.eligibleFolders[0]!.examples = [
      {
        title: spoofed[0]!.page.title,
        domain: spoofed[0]!.page.domain,
        sourcePageId: 'pretend-external-page',
      },
    ];
    expect(() => validateEvaluationSet(spoofed)).toThrow('held out');

    const missingSource = evaluationCases(100) as unknown as Array<{
      eligibleFolders: Array<{ examples: Array<Record<string, unknown>> }>;
    }>;
    missingSource[1]!.eligibleFolders[0]!.examples = [
      { title: 'Missing source', domain: 'example.com' },
    ];
    expect(() => validateEvaluationSet(missingSource as unknown as EvaluationCase[])).toThrow(
      'sourcePageId',
    );

    const emptyFolderIdentity = evaluationCases(100);
    emptyFolderIdentity[0] = {
      ...emptyFolderIdentity[0]!,
      expectedFolderId: '',
      pendingFolderId: '',
      eligibleFolders: [],
    };
    expect(() => validateEvaluationSet(emptyFolderIdentity)).toThrow('schema');
  });
});

describe('private-beta quality gate', () => {
  it('accepts the documented overall thresholds and always reports coverage', () => {
    const result = evaluateBetaGate({
      sampleSize: 100,
      top1Accuracy: 0.8,
      top3Accuracy: 0.95,
      automaticSavePrecision: 0.95,
      automaticSaveCoverage: 0,
    });

    expect(result).toEqual({
      passed: true,
      failures: [],
      automaticSaveCoverage: 0,
    });
  });

  it('rejects every metric below its threshold and missing Automatic Save Precision', () => {
    expect(evaluateBetaGate({
      sampleSize: 100,
      top1Accuracy: 0.79,
      top3Accuracy: 0.94,
      automaticSavePrecision: 0.94,
      automaticSaveCoverage: 0.42,
    })).toEqual({
      passed: false,
      failures: [
        'Overall Top-1 accuracy 79.00% is below 80.00%',
        'Overall Top-3 accuracy 94.00% is below 95.00%',
        'Automatic Save Precision 94.00% is below 95.00%',
      ],
      automaticSaveCoverage: 0.42,
    });

    expect(evaluateBetaGate({
      sampleSize: 100,
      top1Accuracy: 1,
      top3Accuracy: 1,
      automaticSavePrecision: null,
      automaticSaveCoverage: 0,
    }).failures).toEqual([
      'Automatic Save Precision is unavailable because no pages qualified for Automatic Save',
    ]);
  });
});

function evaluationCases(count: number): EvaluationCase[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `case-${index}`,
    language: index % 2 === 0 ? 'zh' : 'en',
    labelSource: 'manual',
    expectedFolderId: 'folder-correct',
    pendingFolderId: 'pending-folder',
    page: {
      title: `Page ${index}`,
      url: `https://example.com/${index}`,
      domain: 'example.com',
      description: '',
      h1: '',
      visibleText: '',
    },
    eligibleFolders: [
      { id: 'folder-correct', path: '书签栏 / Correct', examples: [] },
      { id: 'folder-wrong', path: '书签栏 / Wrong', examples: [] },
    ],
  }));
}
