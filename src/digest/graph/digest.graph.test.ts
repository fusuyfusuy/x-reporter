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
              highlights: ['Revamped state', 'Send fanout', 'Reducers'],
            }),
          usage: { tokensIn: 40, tokensOut: 15 },
        },
        {
          match: (opts) =>
            opts.messages[0]?.content.includes('Topic: Runtimes') ?? false,
          respond: () =>
            JSON.stringify({
              summary: 'Bun 1.3 and NestJS 11 both push the runtime frontier.',
              highlights: ['Bun Node compat', 'Nest DI perf', 'Perf gains'],
            }),
          usage: { tokensIn: 45, tokensOut: 18 },
        },
        {
          match: (opts) =>
            opts.messages[0]?.content.includes('Score each cluster from 1 to 10') ?? false,
          respond: () =>
            JSON.stringify({
              scores: [
                { id: 'c0', score: 9 },
                { id: 'c1', score: 6 },
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
            JSON.stringify({
              summary: 'Primary cluster.',
              highlights: ['point a', 'point b', 'point c'],
            }),
        },
        {
          match: (opts) => opts.messages[0]?.content.includes('Topic: Misc') ?? false,
          respond: () =>
            JSON.stringify({
              summary: 'Misc cluster.',
              highlights: ['leftover a', 'leftover b', 'leftover c'],
            }),
        },
        {
          match: (opts) =>
            opts.messages[0]?.content.includes('Score each cluster') ?? false,
          respond: () =>
            JSON.stringify({
              scores: [
                { id: 'c0', score: 8 },
                { id: 'c1', score: 3 },
              ],
            }),
        },
        {
          // Compose stub echoes back cluster topics from its input so we can
          // prove the Misc cluster actually reaches the final digest rather
          // than being filtered out somewhere upstream.
          match: (opts) =>
            opts.messages[0]?.content.includes('Compose a personalized digest') ?? false,
          respond: (opts) => {
            const prompt = opts.messages[0]?.content ?? '';
            const topics: string[] = [];
            for (const match of prompt.matchAll(/###\s+\d+\.\s+([^\n(]+?)\s*\(/g)) {
              const topic = match[1];
              if (topic) topics.push(topic.trim());
            }
            return topics.map((t) => `## ${t}\n\n${t} body.\n`).join('\n');
          },
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
    expect(result.markdown).toContain('## Misc');
    expect(result.markdown).toContain('Misc body.');
    // cluster + 2 summarize + rank + compose = 5
    expect(stub.calls).toHaveLength(5);
  });

  it('orders compose input by rank score, descending, regardless of cluster order', async () => {
    // This pins the rank-node ordering contract: even when the cluster
    // node produces [High, Low] order, a low score for `High` + high
    // score for `Low` should flip the order when compose receives the
    // ranked list. The compose stub captures the prompt so we can
    // inspect the prefix/position of each cluster in the input.
    let capturedComposePrompt = '';
    const stub = new StubLlmProvider({
      handlers: [
        {
          match: (opts) =>
            opts.messages[0]?.content.includes('Group the following items') ?? false,
          respond: () =>
            JSON.stringify({
              clusters: [
                { topic: 'Alpha', itemIds: ['i1'] },
                { topic: 'Bravo', itemIds: ['i2'] },
                { topic: 'Charlie', itemIds: ['i3'] },
              ],
            }),
        },
        {
          match: (opts) => opts.messages[0]?.content.includes('Topic: Alpha') ?? false,
          respond: () =>
            JSON.stringify({
              summary: 'Alpha summary.',
              highlights: ['a1', 'a2', 'a3'],
            }),
        },
        {
          match: (opts) => opts.messages[0]?.content.includes('Topic: Bravo') ?? false,
          respond: () =>
            JSON.stringify({
              summary: 'Bravo summary.',
              highlights: ['b1', 'b2', 'b3'],
            }),
        },
        {
          match: (opts) => opts.messages[0]?.content.includes('Topic: Charlie') ?? false,
          respond: () =>
            JSON.stringify({
              summary: 'Charlie summary.',
              highlights: ['c1', 'c2', 'c3'],
            }),
        },
        {
          match: (opts) => opts.messages[0]?.content.includes('Score each cluster') ?? false,
          // Invert: Alpha=2, Bravo=9, Charlie=5 → expected ranked order Bravo, Charlie, Alpha
          respond: () =>
            JSON.stringify({
              scores: [
                { id: 'c0', score: 2 },
                { id: 'c1', score: 9 },
                { id: 'c2', score: 5 },
              ],
            }),
        },
        {
          match: (opts) =>
            opts.messages[0]?.content.includes('Compose a personalized digest') ?? false,
          respond: (opts) => {
            capturedComposePrompt = opts.messages[0]?.content ?? '';
            // Emit minimal markdown that matches ordering so we can
            // also verify the result.markdown surfaces that order.
            return '## Bravo\n\nBravo body.\n\n## Charlie\n\nCharlie body.\n\n## Alpha\n\nAlpha body.\n';
          },
        },
      ],
    });

    const graph = new DigestGraph(stub);
    const result = await graph.run({
      userId: 'u',
      window: { start: new Date(), end: new Date() },
      items: makeItems(),
    });

    // The compose prompt lists clusters using "### N. Topic (score=..." —
    // verify the positional ordering matches rank-descending.
    const bravoIdx = capturedComposePrompt.indexOf('### 1. Bravo');
    const charlieIdx = capturedComposePrompt.indexOf('### 2. Charlie');
    const alphaIdx = capturedComposePrompt.indexOf('### 3. Alpha');
    expect(bravoIdx).toBeGreaterThanOrEqual(0);
    expect(charlieIdx).toBeGreaterThan(bravoIdx);
    expect(alphaIdx).toBeGreaterThan(charlieIdx);
    // Scores surface in the prompt too.
    expect(capturedComposePrompt).toContain('(score=9)');
    expect(capturedComposePrompt).toContain('(score=5)');
    expect(capturedComposePrompt).toContain('(score=2)');

    // Final markdown reflects rank ordering: Bravo, then Charlie, then Alpha.
    const mdBravoIdx = result.markdown.indexOf('## Bravo');
    const mdCharlieIdx = result.markdown.indexOf('## Charlie');
    const mdAlphaIdx = result.markdown.indexOf('## Alpha');
    expect(mdBravoIdx).toBeGreaterThanOrEqual(0);
    expect(mdCharlieIdx).toBeGreaterThan(mdBravoIdx);
    expect(mdAlphaIdx).toBeGreaterThan(mdCharlieIdx);

    // All three items still surface on the result.
    expect(result.itemIds).toEqual(['i1', 'i2', 'i3']);
    // cluster + 3 summarize + rank + compose = 6 calls
    expect(stub.calls).toHaveLength(6);
  });
});
