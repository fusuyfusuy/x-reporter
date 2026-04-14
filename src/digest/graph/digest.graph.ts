/**
 * LangGraph `DigestGraph` — orchestrates the four digest nodes.
 *
 * Public API is intentionally narrow: callers hand `DigestGraph` a list of
 * `EnrichedItem`s and get back `{ markdown, itemIds, usage }`. The LangGraph
 * types never cross this boundary; if we swap orchestrators later, the
 * processor in #11 doesn't change.
 *
 * Fanout: after `cluster` completes, a conditional edge emits one `Send`
 * per cluster targeting the `summarize` node. LangGraph runs those in
 * parallel and the `summaries` reducer concatenates the results before the
 * graph moves on to `rank`.
 */
import { END, START, Send, StateGraph } from '@langchain/langgraph';
import type { LlmProvider } from '../llm/llm-provider.interface';
import {
  type DigestState,
  DigestStateAnnotation,
  type EnrichedItem,
  type TokenUsage,
} from './digest-state';
import { makeClusterNode } from './nodes/cluster.node';
import { makeComposeNode } from './nodes/compose.node';
import { makeRankNode } from './nodes/rank.node';
import { type SummarizePayload, makeSummarizeNode } from './nodes/summarize.node';

export interface DigestInput {
  userId: string;
  window: { start: Date; end: Date };
  items: EnrichedItem[];
}

export interface DigestResult {
  markdown: string;
  itemIds: string[];
  usage: TokenUsage;
  model: string;
}

/**
 * Router that turns the cluster list into a parallel summarize fanout.
 * Each `Send` carries only the items belonging to that cluster (looked up
 * by id) so we don't pay O(N*M) memory across the fanout. Returning `rank`
 * directly when there are no clusters lets the graph short-circuit.
 */
function routeClustersToSummarize(state: DigestState): Send[] | 'rank' {
  const clusters = state.clusters ?? [];
  if (clusters.length === 0) return 'rank';
  const itemsById = new Map(state.items.map((i) => [i.id, i]));
  return clusters.map(
    (cluster) =>
      new Send('summarize', {
        cluster,
        items: cluster.itemIds
          .map((id) => itemsById.get(id))
          .filter((i): i is (typeof state.items)[number] => i !== undefined),
      } satisfies SummarizePayload),
  );
}

function buildCompiledGraph(llm: LlmProvider) {
  const clusterNode = makeClusterNode(llm);
  const summarizeNode = makeSummarizeNode(llm);
  const rankNode = makeRankNode(llm);
  const composeNode = makeComposeNode(llm);

  return new StateGraph(DigestStateAnnotation)
    .addNode('cluster', clusterNode)
    .addNode('summarize', summarizeNode)
    .addNode('rank', rankNode)
    .addNode('compose', composeNode)
    .addEdge(START, 'cluster')
    .addConditionalEdges('cluster', routeClustersToSummarize, ['summarize', 'rank'])
    .addEdge('summarize', 'rank')
    .addEdge('rank', 'compose')
    .addEdge('compose', END)
    .compile();
}

export class DigestGraph {
  private readonly app: ReturnType<typeof buildCompiledGraph>;

  constructor(private readonly llm: LlmProvider) {
    this.app = buildCompiledGraph(llm);
  }

  async run(input: DigestInput): Promise<DigestResult> {
    const final = (await this.app.invoke({
      userId: input.userId,
      window: input.window,
      items: input.items,
      model: this.llm.model,
    })) as DigestState;

    return {
      markdown: final.markdown ?? '',
      itemIds: input.items.map((i) => i.id),
      usage: final.usage,
      model: this.llm.model,
    };
  }
}
