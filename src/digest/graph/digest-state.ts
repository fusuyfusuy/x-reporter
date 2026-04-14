/**
 * LangGraph state definition for the digest pipeline.
 *
 * The `DigestState` Annotation is the single source of truth for the shape
 * flowing through the graph. Each node returns a `Partial<DigestState>` and
 * the annotation's reducers fold those updates into the running state.
 *
 * Only the `usage` channel has a custom reducer — every node that calls the
 * `LlmProvider` adds its `tokensIn`/`tokensOut` contribution and the reducer
 * sums them so the final state carries a running total. All other channels
 * use the default "last write wins" semantics, which matches the linear
 * `cluster → summarize → rank → compose` edge layout.
 *
 * See `docs/llm-and-graph.md` for field-level semantics.
 */
import { Annotation } from '@langchain/langgraph';

export interface EnrichedItem {
  id: string;
  text: string;
  authorHandle: string;
  kind: 'like' | 'bookmark';
  articles: {
    title?: string;
    siteName?: string;
    url: string;
    content: string;
  }[];
}

export interface Cluster {
  topic: string;
  itemIds: string[];
}

export interface ClusterSummary {
  topic: string;
  itemIds: string[];
  summary: string;
  highlights: string[];
  score?: number;
}

export interface TokenUsage {
  tokensIn: number;
  tokensOut: number;
}

export interface DigestWindow {
  start: Date;
  end: Date;
}

/**
 * Summing reducer for `usage`. The default starting value is zero so the
 * graph never observes `undefined` tokens.
 */
function addUsage(left: TokenUsage, right: TokenUsage): TokenUsage {
  return {
    tokensIn: left.tokensIn + right.tokensIn,
    tokensOut: left.tokensOut + right.tokensOut,
  };
}

/**
 * Reducer that concatenates per-cluster summaries produced by the
 * `summarize` fanout. Each invocation of the summarize node returns a
 * one-element array, so the reducer simply appends them.
 */
function appendSummaries(
  left: ClusterSummary[] | undefined,
  right: ClusterSummary[] | undefined,
): ClusterSummary[] {
  return [...(left ?? []), ...(right ?? [])];
}

export const DigestStateAnnotation = Annotation.Root({
  userId: Annotation<string>(),
  window: Annotation<DigestWindow>(),
  items: Annotation<EnrichedItem[]>(),
  model: Annotation<string>(),
  clusters: Annotation<Cluster[] | undefined>(),
  summaries: Annotation<ClusterSummary[] | undefined>({
    reducer: appendSummaries,
    default: () => [],
  }),
  ranked: Annotation<ClusterSummary[] | undefined>(),
  markdown: Annotation<string | undefined>(),
  usage: Annotation<TokenUsage>({
    reducer: addUsage,
    default: () => ({ tokensIn: 0, tokensOut: 0 }),
  }),
});

export type DigestState = typeof DigestStateAnnotation.State;
export type DigestStateUpdate = typeof DigestStateAnnotation.Update;
