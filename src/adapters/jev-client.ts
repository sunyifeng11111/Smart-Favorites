import type {
  JevClassificationRequest,
  JevClassificationResult,
  JevPort,
} from '../application/types';

const SYSTEM_ONE_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';

export type JevErrorCode =
  | 'invalid-key'
  | 'invalid-request'
  | 'temporarily-unavailable'
  | 'invalid-response';

export class JevClientError extends Error {
  constructor(readonly code: JevErrorCode) {
    super(code);
    this.name = 'JevClientError';
  }
}

interface HttpJevClientOptions {
  fetcher?: typeof fetch;
  delay?: (milliseconds: number) => Promise<void>;
  timeoutMs?: number;
  random?: () => number;
}

export class HttpJevClient implements JevPort {
  private readonly fetcher: typeof fetch;
  private readonly delay: (milliseconds: number) => Promise<void>;
  private readonly timeoutMs: number;
  private readonly random: () => number;

  constructor(options: HttpJevClientOptions = {}) {
    this.fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
    this.delay = options.delay ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.random = options.random ?? Math.random;
  }

  async classify(
    request: JevClassificationRequest,
    apiKey: string,
  ): Promise<JevClassificationResult> {
    const body = JSON.stringify({
      state: request.page,
      model: 'jev-latest',
      questions: {
        destination: {
          type: 'choice',
          instructions:
            'Choose the single existing bookmark folder that best fits this page. Choose no_match when none is suitable.',
          criteria: request.criteria,
        },
      },
    });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await this.post(body, apiKey);
        if ((response.status === 429 || response.status === 529) && attempt === 0) {
          await this.delay(this.retryDelay(attempt));
          continue;
        }
        if (response.status === 401) throw new JevClientError('invalid-key');
        if (response.status === 422) throw new JevClientError('invalid-request');
        if (!response.ok) throw new JevClientError('temporarily-unavailable');

        let payload: unknown;
        try {
          payload = await response.json();
        } catch {
          throw new JevClientError('invalid-response');
        }
        return validateChoiceAnswer(payload, new Set(Object.keys(request.criteria)));
      } catch (error) {
        if (error instanceof JevClientError) throw error;
        if (attempt === 0) {
          await this.delay(this.retryDelay(attempt));
          continue;
        }
        throw new JevClientError('temporarily-unavailable');
      }
    }

    throw new JevClientError('temporarily-unavailable');
  }

  async testKey(apiKey: string): Promise<void> {
    await this.classify(
      {
        page: {
          title: 'Connection test',
          url: 'https://api.typesafe.ai/',
          domain: 'api.typesafe.ai',
          description: '',
          h1: '',
          visibleText: '',
        },
        criteria: {
          valid: 'Choose this option for the connection test',
          __no_match__: 'Fallback option',
        },
      },
      apiKey,
    );
  }

  private async post(body: string, apiKey: string): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetcher(SYSTEM_ONE_ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  private retryDelay(attempt: number): number {
    const exponentialBackoff = 250 * (2 ** attempt);
    const jitter = Math.floor(this.random() * 250);
    return exponentialBackoff + jitter;
  }
}

function validateChoiceAnswer(
  payload: unknown,
  allowedKeys: ReadonlySet<string>,
): JevClassificationResult {
  const answer = getDestinationAnswer(payload);
  if (answer.type !== 'choice' || typeof answer.choice !== 'string') {
    throw new JevClientError('invalid-response');
  }
  if (!allowedKeys.has(answer.choice) || !isProbability(answer.confidence)) {
    throw new JevClientError('invalid-response');
  }
  if (!isRecord(answer.probabilities)) throw new JevClientError('invalid-response');

  const probabilities: Record<string, number> = {};
  for (const [key, probability] of Object.entries(answer.probabilities)) {
    if (!allowedKeys.has(key) || !isProbability(probability)) {
      throw new JevClientError('invalid-response');
    }
    probabilities[key] = probability;
  }
  if (!(answer.choice in probabilities)) throw new JevClientError('invalid-response');

  return { choice: answer.choice, confidence: answer.confidence, probabilities };
}

function getDestinationAnswer(payload: unknown): Record<string, unknown> {
  if (!isRecord(payload) || !isRecord(payload.answers)) {
    throw new JevClientError('invalid-response');
  }
  const destination = payload.answers.destination;
  if (!isRecord(destination)) throw new JevClientError('invalid-response');
  return destination;
}

function isProbability(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
