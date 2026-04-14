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
 * Returning `END` directly when there are no clusters lets the graph
 * short-circuit to `rank` (which also handles the empty case).
 */
function routeClustersToSummarize(state: DigestState): Send[] | 'rank' {
  const clusters = state.clusters ?? [];
  if (clusters.length === 0) return 'rank';
  return clusters.map(
    (cluster) =>
      new Send('summarize', {
        cluster,
        items: state.items,
      } satisfies SummarizePayload),
  );
}

export class DigestGraph {
  constructor(private readonly llm: LlmProvider) {}

  private build() {
    const clusterNode = makeClusterNode(this.llm);
    const summarizeNode = makeSummarizeNode(this.llm);
    const rankNode = makeRankNode(this.llm);
    const composeNode = makeComposeNode(this.llm);

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

  async run(input: DigestInput): Promise<DigestResult> {
    const app = this.build();
    const final = (await app.invoke({
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
