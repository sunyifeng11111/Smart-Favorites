import { NO_MATCH_OPTION, type JevClassificationRequest } from '../application/types';
import { qualifiesForAutomaticSave } from '../application/classification-policy';

export interface EvaluationFolderExample {
  title: string;
  domain: string;
  sourcePageId: string;
}

export interface EvaluationFolder {
  id: string;
  path: string;
  examples: EvaluationFolderExample[];
}

export interface EvaluationCase {
  id: string;
  language: 'zh' | 'en';
  labelSource: 'manual';
  expectedFolderId: string;
  pendingFolderId: string;
  page: JevClassificationRequest['page'];
  eligibleFolders: EvaluationFolder[];
}

export interface EvaluationResult {
  caseId: string;
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}

export interface EvaluationMetrics {
  sampleSize: number;
  top1Accuracy: number;
  top3Accuracy: number;
  automaticSavePrecision: number | null;
  automaticSaveCoverage: number;
}

export interface EvaluationReport {
  zh: EvaluationMetrics;
  en: EvaluationMetrics;
  full: EvaluationMetrics;
}

export async function runEvaluationSet(
  cases: EvaluationCase[],
  classify: (
    request: JevClassificationRequest,
    item: EvaluationCase,
  ) => Promise<Omit<EvaluationResult, 'caseId'>>,
): Promise<{ results: EvaluationResult[]; report: EvaluationReport }> {
  validateEvaluationSet(cases);
  const results: EvaluationResult[] = [];
  for (const item of cases) {
    results.push({
      caseId: item.id,
      ...await classify(buildEvaluationRequest(item), item),
    });
  }
  return { results, report: evaluateClassificationResults(cases, results) };
}

export function validateEvaluationSet(cases: unknown): asserts cases is EvaluationCase[] {
  if (!Array.isArray(cases) || !cases.every(hasEvaluationCaseShape)) {
    throw new Error('Evaluation Set does not match the required schema, including sourcePageId');
  }
  if (cases.length < 100) throw new Error('Evaluation Set must contain at least 100 pages');
  const pageIds = new Set(cases.map(({ id }) => id));
  const pageExampleIdentities = new Set(
    cases.map(({ page }) => folderExampleIdentity(page.title, page.domain)),
  );
  if (pageIds.size !== cases.length) throw new Error('Evaluation Set page ids must be unique');

  for (const item of cases) {
    if (item.labelSource !== 'manual') {
      throw new Error(`Evaluation page ${item.id} is not manually labeled`);
    }
    const folderIds = new Set(item.eligibleFolders.map(({ id }) => id));
    if (
      item.expectedFolderId !== item.pendingFolderId &&
      !folderIds.has(item.expectedFolderId)
    ) {
      throw new Error(`Evaluation page ${item.id} has an unknown exact folder identity`);
    }
    for (const folder of item.eligibleFolders) {
      for (const example of folder.examples) {
        if (
          pageIds.has(example.sourcePageId) ||
          pageExampleIdentities.has(folderExampleIdentity(example.title, example.domain))
        ) {
          throw new Error(
            `Evaluation Set pages must be held out from Folder Examples: ${example.sourcePageId}`,
          );
        }
      }
    }
  }
}

export function buildEvaluationRequest(item: EvaluationCase): JevClassificationRequest {
  return {
    page: item.page,
    criteria: Object.fromEntries([
      ...item.eligibleFolders.map((folder) => [
        folder.id,
        {
          path: folder.path,
          examples: folder.examples.map(({ title, domain }) => ({ title, domain })),
        },
      ]),
      [NO_MATCH_OPTION, 'No existing folder is suitable'],
    ]),
  };
}

export function evaluateClassificationResults(
  cases: EvaluationCase[],
  results: EvaluationResult[],
): EvaluationReport {
  validateEvaluationSet(cases);
  const byCaseId = new Map(results.map((result) => [result.caseId, result]));
  if (byCaseId.size !== cases.length || results.length !== cases.length) {
    throw new Error('Evaluation results must contain exactly one response for every page');
  }
  const measured = cases.map((item) => {
    const result = byCaseId.get(item.id);
    if (!result) throw new Error(`Missing evaluation response for ${item.id}`);
    const choice = resolvedFolderId(result.choice, item.pendingFolderId);
    const top3 = Object.entries(result.probabilities)
      .sort((left, right) => right[1] - left[1])
      .slice(0, 3)
      .map(([folderId]) => resolvedFolderId(folderId, item.pendingFolderId));
    const automatic = result.choice !== NO_MATCH_OPTION && qualifiesForAutomaticSave(result);
    return {
      language: item.language,
      top1Correct: choice === item.expectedFolderId,
      top3Correct: top3.includes(item.expectedFolderId),
      automatic,
    };
  });
  return {
    zh: metrics(measured.filter(({ language }) => language === 'zh')),
    en: metrics(measured.filter(({ language }) => language === 'en')),
    full: metrics(measured),
  };
}

function metrics(
  items: Array<{
    top1Correct: boolean;
    top3Correct: boolean;
    automatic: boolean;
  }>,
): EvaluationMetrics {
  const automatic = items.filter((item) => item.automatic);
  return {
    sampleSize: items.length,
    top1Accuracy: ratio(items.filter((item) => item.top1Correct).length, items.length),
    top3Accuracy: ratio(items.filter((item) => item.top3Correct).length, items.length),
    automaticSavePrecision: automatic.length === 0
      ? null
      : ratio(automatic.filter((item) => item.top1Correct).length, automatic.length),
    automaticSaveCoverage: ratio(automatic.length, items.length),
  };
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function resolvedFolderId(choice: string, pendingFolderId: string): string {
  return choice === NO_MATCH_OPTION ? pendingFolderId : choice;
}

function hasEvaluationCaseShape(value: unknown): value is EvaluationCase {
  if (!isRecord(value) || !isRecord(value.page) || !Array.isArray(value.eligibleFolders)) {
    return false;
  }
  if (
    !isNonEmptyString(value.id) ||
    (value.language !== 'zh' && value.language !== 'en') ||
    typeof value.labelSource !== 'string' ||
    !isNonEmptyString(value.expectedFolderId) ||
    !isNonEmptyString(value.pendingFolderId) ||
    !hasStringFields(value.page, ['title', 'url', 'domain', 'description', 'h1', 'visibleText'])
  ) {
    return false;
  }
  return value.eligibleFolders.every((folder) => {
    if (
      !isRecord(folder) ||
      !isNonEmptyString(folder.id) ||
      !isNonEmptyString(folder.path) ||
      !Array.isArray(folder.examples)
    ) {
      return false;
    }
    return folder.examples.every((example) => {
      return isRecord(example) &&
        hasStringFields(example, ['title', 'domain']) &&
        isNonEmptyString(example.sourcePageId);
    });
  });
}

function folderExampleIdentity(title: string, domain: string): string {
  return `${title.trim().toLocaleLowerCase()}\n${domain.trim().toLocaleLowerCase()}`;
}

function hasStringFields(value: Record<string, unknown>, fields: string[]): boolean {
  return fields.every((field) => typeof value[field] === 'string');
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
