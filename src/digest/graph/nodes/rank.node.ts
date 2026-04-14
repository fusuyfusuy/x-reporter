/**
 * `rank` node: a single LLM call that scores each cluster 1–10 for
 * newsworthiness and signal density. Output is sorted descending by score
 * and surfaced as `state.ranked`.
 *
 * Clusters that the LLM omits are ranked last with `score = 0` so no
 * summary is silently dropped.
 */
import { z } from 'zod';
import type { LlmProvider } from '../../llm/llm-provider.interface';
import type { ClusterSummary, DigestState, DigestStateUpdate } from '../digest-state';

export const RANK_SYSTEM_PROMPT =
  'You are an editorial assistant that scores topic clusters on signal and newsworthiness for a reader whose interests are reflected in the source items. Respond with JSON only.';

export const RANK_USER_PROMPT = `Score each cluster from 1 to 10 on newsworthiness and signal density.
Higher scores mean the reader will get more value from reading it. Do not
deduplicate or rewrite — just score. Echo back the exact cluster id.

Return JSON of the form:
{
  "scores": [
    { "id": "c0", "score": 8 }
  ]
}

Clusters:
`;

const RankResponseSchema = z.object({
  scores: z.array(z.object({ id: z.string(), score: z.number() })),
});

function formatSummaries(summaries: ClusterSummary[]): string {
  return summaries
    .map((s) => `- id=${s.id} topic="${s.topic}": ${s.summary}`)
    .join('\n');
}

export function makeRankNode(llm: LlmProvider) {
  return async function rankNode(state: DigestState): Promise<DigestStateUpdate> {
    const summaries = state.summaries ?? [];
    if (summaries.length === 0) {
      return { ranked: [] };
    }

    const result = await llm.chat({
      system: RANK_SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: RANK_USER_PROMPT + formatSummaries(summaries),
        },
      ],
      responseFormat: 'json',
      temperature: 0.1,
    });

    const parsed = RankResponseSchema.parse(JSON.parse(result.content));
    const scoreById = new Map<string, number>();
    for (const s of parsed.scores) {
      if (!scoreById.has(s.id)) scoreById.set(s.id, s.score);
    }

    const ranked = summaries
      .map((s) => ({ ...s, score: scoreById.get(s.id) ?? 0 }))
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

    return {
      ranked,
      usage: result.usage,
    };
  };
}
