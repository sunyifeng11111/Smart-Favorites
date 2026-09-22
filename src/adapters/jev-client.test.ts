import { describe, expect, it, vi } from 'vitest';

import { HttpJevClient, JevClientError } from './jev-client';
import type { JevClassificationRequest } from '../application/types';

const request: JevClassificationRequest = {
  page: {
    title: 'TypeSafe API',
    url: 'https://docs.typesafe.ai/api',
    domain: 'docs.typesafe.ai',
    description: 'API reference',
    h1: 'API reference',
    visibleText: 'Evaluate state against typed questions.',
  },
  criteria: {
    '10': '书签栏 / 开发',
    '11': '书签栏 / 阅读',
    __no_match__: 'No existing folder is suitable',
  },
};

describe('HttpJevClient', () => {
  it('posts one destination Choice to System One using jev-latest', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          model: 'jev-1.13.0',
          answers: {
            destination: {
              type: 'choice',
              choice: '10',
              probabilities: { '10': 0.8, '11': 0.15, __no_match__: 0.05 },
              confidence: 0.91,
            },
          },
          usage: { input_tokens: 100, output_tokens: 20 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    const client = new HttpJevClient({ fetcher, delay: async () => undefined });

    const result = await client.classify(request, 'jev-secret');

    expect(result).toEqual({
      choice: '10',
      probabilities: { '10': 0.8, '11': 0.15, __no_match__: 0.05 },
      confidence: 0.91,
    });
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0] ?? [];
    expect(url).toBe('https://api.typesafe.ai/v1/systemone');
    expect(init).toMatchObject({
      method: 'POST',
      headers: {
        Authorization: 'Bearer jev-secret',
        'Content-Type': 'application/json',
      },
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      state: request.page,
      model: 'jev-latest',
      questions: {
        destination: {
          type: 'choice',
          instructions: 'Choose the single existing bookmark folder that best fits this page. Choose no_match when none is suitable.',
          criteria: request.criteria,
        },
      },
    });
    expect(String(init?.body)).not.toContain('jev-secret');
  });

  it('rejects unknown response keys without exposing the API key', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          answers: {
            destination: {
              type: 'choice',
              choice: 'invented-folder',
              probabilities: { '10': 0.5, 'invented-folder': 0.5 },
              confidence: 0.2,
            },
          },
        }),
        { status: 200 },
      ),
    );
    const client = new HttpJevClient({ fetcher, delay: async () => undefined });

    const error = await client.classify(request, 'do-not-leak-this').catch((caught) => caught);

    expect(error).toBeInstanceOf(JevClientError);
    expect(error).toMatchObject({ code: 'invalid-response' });
    expect(String(error)).not.toContain('do-not-leak-this');
  });
});
