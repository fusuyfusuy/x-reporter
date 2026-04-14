/**
 * `compose` node: a single LLM call that renders the ranked summaries into
 * the final markdown digest. No validation schema — the output is free-form
 * markdown rather than JSON — but a zod check guards against empty strings.
 */
import { z } from 'zod';
import type { LlmProvider } from '../../llm/llm-provider.interface';
import type {
  ClusterSummary,
  DigestState,
  DigestStateUpdate,
  EnrichedItem,
} from '../digest-state';

export const COMPOSE_SYSTEM_PROMPT =
  'You are an editorial assistant that composes personalized markdown digests. Write tight, scannable prose.';

export const COMPOSE_USER_PROMPT_PREFIX = `Compose a personalized digest in markdown using the ranked clusters below.

Formatting rules:
- Start with the highest-ranked cluster.
- Each cluster gets an "##" header using its topic label.
- Follow each header with the synthesis paragraph, then the bullet highlights as a "-" list.
- End each section with a "Sources" sub-list containing ONLY the URLs listed under that cluster's "Sources:" block below (use raw links, do not invent URLs).
- Keep it tight — no filler intro or outro.

Clusters:
`;

const MarkdownSchema = z.string().min(1);

function collectUrls(itemIds: string[], items: EnrichedItem[]): string[] {
  const idSet = new Set(itemIds);
  const urls: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (!idSet.has(item.id)) continue;
    for (const article of item.articles) {
      if (seen.has(article.url)) continue;
      seen.add(article.url);
      urls.push(article.url);
    }
  }
  return urls;
}

function formatRankedForPrompt(ranked: ClusterSummary[], items: EnrichedItem[]): string {
  return ranked
    .map((s, i) => {
      const highlights = s.highlights.map((h) => `  - ${h}`).join('\n');
      const urls = collectUrls(s.itemIds, items);
      const sources =
        urls.length > 0
          ? `Sources:\n${urls.map((u) => `  - ${u}`).join('\n')}`
          : 'Sources: (none)';
      return `### ${i + 1}. ${s.topic} (score=${s.score ?? 0})\n${s.summary}\nHighlights:\n${highlights}\n${sources}`;
    })
    .join('\n\n');
}

export function makeComposeNode(llm: LlmProvider) {
  return async function composeNode(state: DigestState): Promise<DigestStateUpdate> {
    const ranked = state.ranked ?? [];
    if (ranked.length === 0) {
      return { markdown: '' };
    }

    const result = await llm.chat({
      system: COMPOSE_SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: COMPOSE_USER_PROMPT_PREFIX + formatRankedForPrompt(ranked, state.items),
        },
      ],
      responseFormat: 'text',
      temperature: 0.4,
    });

    const markdown = MarkdownSchema.parse(result.content.trim());

    return {
      markdown,
      usage: result.usage,
    };
  };
}
