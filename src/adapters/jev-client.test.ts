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

  it.each([
    { retryClass: 'network error', first: new TypeError('network offline') },
    { retryClass: 'HTTP 429', first: new Response('', { status: 429 }) },
    { retryClass: 'HTTP 529', first: new Response('', { status: 529 }) },
  ])('retries $retryClass once after exponential backoff with jitter', async ({ first }) => {
    const fetcher = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(first)
      .mockResolvedValueOnce(validResponse());
    if (first instanceof Response) {
      fetcher.mockReset();
      fetcher.mockResolvedValueOnce(first).mockResolvedValueOnce(validResponse());
    }
    const delay = vi.fn(async () => undefined);
    const client = new HttpJevClient({ fetcher, delay, random: () => 0.5 });

    await expect(client.classify(request, 'jev-secret')).resolves.toMatchObject({ choice: '10' });

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(delay).toHaveBeenCalledOnce();
    expect(delay).toHaveBeenCalledWith(375);
  });

  it.each([
    { status: 401, code: 'invalid-key' },
    { status: 422, code: 'invalid-request' },
  ] as const)('does not retry HTTP $status', async ({ status, code }) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status }));
    const delay = vi.fn(async () => undefined);
    const client = new HttpJevClient({ fetcher, delay });

    const error = await client.classify(request, 'jev-secret').catch((caught) => caught);

    expect(error).toMatchObject({ code });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(delay).not.toHaveBeenCalled();
  });

  it('does not retry a malformed successful response', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ answers: { destination: { type: 'text' } } }), {
        status: 200,
      }),
    );
    const delay = vi.fn(async () => undefined);
    const client = new HttpJevClient({ fetcher, delay });

    const error = await client.classify(request, 'jev-secret').catch((caught) => caught);

    expect(error).toMatchObject({ code: 'invalid-response' });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(delay).not.toHaveBeenCalled();
  });

  it('does not retry an unparseable successful response', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response('{not valid json', { status: 200 }),
    );
    const delay = vi.fn(async () => undefined);
    const client = new HttpJevClient({ fetcher, delay });

    const error = await client.classify(request, 'jev-secret').catch((caught) => caught);

    expect(error).toMatchObject({ code: 'invalid-response' });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(delay).not.toHaveBeenCalled();
  });

  it('times out each JEV attempt after 10 seconds and retries only once', async () => {
    vi.useFakeTimers();
    try {
      const fetcher = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      }));
      const client = new HttpJevClient({
        fetcher,
        delay: async () => undefined,
        random: () => 0,
      });

      const result = client.classify(request, 'jev-secret').catch((caught) => caught);
      await vi.advanceTimersByTimeAsync(10_000);
      await vi.advanceTimersByTimeAsync(10_000);

      await expect(result).resolves.toMatchObject({ code: 'temporarily-unavailable' });
      expect(fetcher).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

function validResponse(): Response {
  return new Response(
    JSON.stringify({
      answers: {
        destination: {
          type: 'choice',
          choice: '10',
          probabilities: { '10': 0.8, '11': 0.15, __no_match__: 0.05 },
          confidence: 0.91,
        },
      },
    }),
    { status: 200 },
  );
}
