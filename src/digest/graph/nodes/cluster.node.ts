/**
 * `cluster` node: asks the LLM to group items into 3–7 topic clusters.
 *
 * One LLM call. JSON response validated with zod; any item missing from the
 * model's output is swept into a single `Misc` cluster so downstream nodes
 * can assume every `EnrichedItem.id` appears in exactly one cluster.
 * Duplicate assignments resolve to the first occurrence.
 */
import { z } from 'zod';
import type { LlmProvider } from '../../llm/llm-provider.interface';
import type { Cluster, DigestState, DigestStateUpdate, EnrichedItem } from '../digest-state';

export const CLUSTER_SYSTEM_PROMPT =
  'You are an editorial assistant that groups social items into coherent topic clusters. Respond with JSON only.';

export const CLUSTER_USER_PROMPT = `Group the following items into 3–7 coherent topic clusters.
Each cluster has a short human-readable label and the list of item IDs that belong to it.
Every item id must appear in exactly one cluster. Prefer fewer clusters when items overlap.

Return JSON of the form:
{
  "clusters": [
    { "topic": "short label", "itemIds": ["id1", "id2"] }
  ]
}

Items:
`;

const ClusterSchema = z.object({
  topic: z.string().min(1),
  itemIds: z.array(z.string()).min(1),
});

const ClusterResponseSchema = z.object({
  clusters: z.array(ClusterSchema).min(1),
});

function formatItems(items: EnrichedItem[]): string {
  return items
    .map((it) => {
      const text = it.text.replace(/\s+/g, ' ').trim();
      return `- id=${it.id} @${it.authorHandle} [${it.kind}]: ${text}`;
    })
    .join('\n');
}

/**
 * Fold LLM output back into a deterministic cluster list:
 *   - keep the first cluster that claims each id (drop duplicates silently)
 *   - sweep unassigned ids into a trailing `Misc` cluster
 *   - drop clusters that end up empty after dedup
 */
function reconcileClusters(raw: Cluster[], items: EnrichedItem[]): Cluster[] {
  const assigned = new Set<string>();
  const knownIds = new Set(items.map((i) => i.id));
  const reconciled: Cluster[] = [];

  for (const c of raw) {
    const uniqueIds: string[] = [];
    for (const id of c.itemIds) {
      if (!knownIds.has(id)) continue;
      if (assigned.has(id)) continue;
      assigned.add(id);
      uniqueIds.push(id);
    }
    if (uniqueIds.length > 0) {
      reconciled.push({ topic: c.topic, itemIds: uniqueIds });
    }
  }

  const leftovers: string[] = [];
  for (const it of items) {
    if (!assigned.has(it.id)) leftovers.push(it.id);
  }
  if (leftovers.length > 0) {
    reconciled.push({ topic: 'Misc', itemIds: leftovers });
  }

  return reconciled;
}

export function makeClusterNode(llm: LlmProvider) {
  return async function clusterNode(state: DigestState): Promise<DigestStateUpdate> {
    const result = await llm.chat({
      system: CLUSTER_SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: CLUSTER_USER_PROMPT + formatItems(state.items),
        },
      ],
      responseFormat: 'json',
      temperature: 0.2,
    });

    const parsed = ClusterResponseSchema.parse(JSON.parse(result.content));
    const clusters = reconcileClusters(parsed.clusters, state.items);

    return {
      clusters,
      usage: result.usage,
    };
  };
}
