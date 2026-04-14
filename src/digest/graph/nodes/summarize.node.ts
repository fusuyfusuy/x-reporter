/**
 * `summarize` node: one LLM call per cluster, fanned out via `Send`.
 *
 * The router in `digest.graph.ts` emits one `Send` per cluster carrying the
 * cluster payload plus the item lookup it needs. Each invocation writes a
 * single-element `summaries` array; the state reducer concatenates them.
 *
 * Article content is truncated to a per-item char budget so we don't blow
 * the context window when a cluster has many long articles.
 */
import { z } from 'zod';
import type { LlmProvider } from '../../llm/llm-provider.interface';
import type {
  Cluster,
  ClusterSummary,
  DigestStateUpdate,
  EnrichedItem,
} from '../digest-state';

export const SUMMARIZE_SYSTEM_PROMPT =
  'You are an editorial assistant that writes tight, high-signal topic summaries. Respond with JSON only.';

export const SUMMARIZE_USER_PROMPT_PREFIX = `Write a 2–4 sentence synthesis of what's worth knowing about this topic cluster, plus 3–6 bullet highlights.
Cite source URLs inline where relevant. Prefer concrete claims over vague framing.

Return JSON of the form:
{
  "summary": "2-4 sentence paragraph",
  "highlights": ["bullet one", "bullet two"]
}

Topic: `;

export const ARTICLE_CHAR_BUDGET = 2000;

export interface SummarizePayload {
  cluster: Cluster;
  items: EnrichedItem[];
}

const SummarizeResponseSchema = z.object({
  summary: z.string().min(1),
  highlights: z.array(z.string()).min(1),
});

function truncate(text: string, budget: number): string {
  if (text.length <= budget) return text;
  return `${text.slice(0, budget)}…`;
}

function formatClusterItems(items: EnrichedItem[]): string {
  return items
    .map((it) => {
      const header = `- id=${it.id} @${it.authorHandle} [${it.kind}]: ${it.text.replace(/\s+/g, ' ').trim()}`;
      if (it.articles.length === 0) return header;
      const articleLines = it.articles
        .map((a) => {
          const title = a.title ? ` "${a.title}"` : '';
          const site = a.siteName ? ` (${a.siteName})` : '';
          return `    · ${a.url}${title}${site}\n      ${truncate(a.content, ARTICLE_CHAR_BUDGET).replace(/\n+/g, ' ')}`;
        })
        .join('\n');
      return `${header}\n${articleLines}`;
    })
    .join('\n');
}

export function makeSummarizeNode(llm: LlmProvider) {
  return async function summarizeNode(payload: SummarizePayload): Promise<DigestStateUpdate> {
    const { cluster, items } = payload;
    const inCluster = items.filter((i) => cluster.itemIds.includes(i.id));

    const result = await llm.chat({
      system: SUMMARIZE_SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: `${SUMMARIZE_USER_PROMPT_PREFIX}${cluster.topic}\n\nItems:\n${formatClusterItems(inCluster)}`,
        },
      ],
      responseFormat: 'json',
      temperature: 0.3,
    });

    const parsed = SummarizeResponseSchema.parse(JSON.parse(result.content));

    const summary: ClusterSummary = {
      topic: cluster.topic,
      itemIds: cluster.itemIds,
      summary: parsed.summary,
      highlights: parsed.highlights,
    };

    return {
      summaries: [summary],
      usage: result.usage,
    };
  };
}
