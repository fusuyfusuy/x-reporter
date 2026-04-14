import { describe, expect, it } from 'bun:test';
import { DigestGraph } from './digest.graph';
import type { EnrichedItem } from './digest-state';
import { StubLlmProvider } from './stub-llm-provider';

function makeItems(): EnrichedItem[] {
  return [
    {
      id: 'i1',
      text: 'LangGraph 1.0 released with new Annotation API.',
      authorHandle: 'alice',
      kind: 'like',
      articles: [
        {
          title: 'LangGraph 1.0',
          siteName: 'LangChain',
          url: 'https://example.com/langgraph-1',
          content: 'LangGraph 1.0 adds a revamped state annotation system.',
        },
      ],
    },
    {
      id: 'i2',
      text: 'Bun 1.3 ships faster Node compat.',
      authorHandle: 'bob',
      kind: 'bookmark',
      articles: [
        {
          url: 'https://example.com/bun-1-3',
          content: 'Bun 1.3 closes more Node.js compatibility gaps.',
        },
      ],
    },
    {
      id: 'i3',
      text: 'NestJS 11 improves DI performance.',
      authorHandle: 'carol',
      kind: 'like',
      articles: [],
    },
  ];
}

describe('DigestGraph', () => {
  it('runs the full cluster → summarize → rank → compose pipeline', async () => {
    const stub = new StubLlmProvider({
      model: 'stub/test',
      defaultUsage: { tokensIn: 10, tokensOut: 20 },
      handlers: [
        {
          match: (opts) =>
            opts.messages[0]?.content.includes('Group the following items into 3–7') ?? false,
          respond: () =>
            JSON.stringify({
              clusters: [
                { topic: 'LangGraph', itemIds: ['i1'] },
                { topic: 'Runtimes', itemIds: ['i2', 'i3'] },
              ],
            }),
          usage: { tokensIn: 100, tokensOut: 50 },
        },
        {
          match: (opts) =>
            opts.messages[0]?.content.includes('Topic: LangGraph') ?? false,
          respond: () =>
            JSON.stringify({
              summary: 'LangGraph 1.0 landed with a new annotation API.',
              highlights: ['Revamped state', 'Send fanout'],
            }),
          usage: { tokensIn: 40, tokensOut: 15 },
        },
        {
          match: (opts) =>
            opts.messages[0]?.content.includes('Topic: Runtimes') ?? false,
          respond: () =>
            JSON.stringify({
              summary: 'Bun 1.3 and NestJS 11 both push the runtime frontier.',
              highlights: ['Bun Node compat', 'Nest DI perf'],
            }),
          usage: { tokensIn: 45, tokensOut: 18 },
        },
        {
          match: (opts) =>
            opts.messages[0]?.content.includes('Score each cluster from 1 to 10') ?? false,
          respond: () =>
            JSON.stringify({
              scores: [
                { topic: 'LangGraph', score: 9 },
                { topic: 'Runtimes', score: 6 },
              ],
            }),
          usage: { tokensIn: 30, tokensOut: 12 },
        },
        {
          match: (opts) =>
            opts.messages[0]?.content.includes('Compose a personalized digest') ?? false,
          respond: () =>
            '## LangGraph\n\nLangGraph 1.0 landed.\n\n- Revamped state\n\n### Sources\n- https://example.com/langgraph-1\n',
          usage: { tokensIn: 60, tokensOut: 80 },
        },
      ],
    });

    const graph = new DigestGraph(stub);
    const result = await graph.run({
      userId: 'user-123',
      window: { start: new Date('2026-04-12'), end: new Date('2026-04-13') },
      items: makeItems(),
    });

    expect(result.markdown).toContain('## LangGraph');
    expect(result.markdown).toContain('https://example.com/langgraph-1');
    expect(result.itemIds).toEqual(['i1', 'i2', 'i3']);
    expect(result.model).toBe('stub/test');

    // Usage accumulates across: cluster(1) + summarize(2) + rank(1) + compose(1) = 5 calls
    expect(stub.calls).toHaveLength(5);
    // tokensIn: 100 + 40 + 45 + 30 + 60 = 275
    // tokensOut: 50 + 15 + 18 + 12 + 80 = 175
    expect(result.usage.tokensIn).toBe(275);
    expect(result.usage.tokensOut).toBe(175);
  });

  it('sweeps unassigned items into a Misc cluster', async () => {
    const stub = new StubLlmProvider({
      handlers: [
        {
          match: (opts) =>
            opts.messages[0]?.content.includes('Group the following items') ?? false,
          // Leave i3 unassigned; it should land in Misc.
          respond: () =>
            JSON.stringify({
              clusters: [{ topic: 'Primary', itemIds: ['i1', 'i2'] }],
            }),
        },
        {
          match: (opts) => opts.messages[0]?.content.includes('Topic: Primary') ?? false,
          respond: () =>
            JSON.stringify({ summary: 'Primary cluster.', highlights: ['point'] }),
        },
        {
          match: (opts) => opts.messages[0]?.content.includes('Topic: Misc') ?? false,
          respond: () =>
            JSON.stringify({ summary: 'Misc cluster.', highlights: ['leftover'] }),
        },
        {
          match: (opts) =>
            opts.messages[0]?.content.includes('Score each cluster') ?? false,
          respond: () =>
            JSON.stringify({
              scores: [
                { topic: 'Primary', score: 8 },
                { topic: 'Misc', score: 3 },
              ],
            }),
        },
        {
          match: (opts) =>
            opts.messages[0]?.content.includes('Compose a personalized digest') ?? false,
          respond: () => '## Primary\n\nPrimary cluster.\n',
        },
      ],
    });

    const graph = new DigestGraph(stub);
    const result = await graph.run({
      userId: 'u',
      window: { start: new Date(), end: new Date() },
      items: makeItems(),
    });

    expect(result.markdown).toContain('## Primary');
    // cluster + 2 summarize + rank + compose = 5
    expect(stub.calls).toHaveLength(5);
  });
});
