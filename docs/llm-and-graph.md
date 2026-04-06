# LLM orchestration & DigestGraph

The digest is built by a LangGraph `StateGraph`. Each node is a pure function
of state that may call the `LlmProvider` interface. The graph itself is
provider-agnostic — swapping OpenRouter for another `LlmProvider` requires no
changes to the graph.

## State

```ts
type EnrichedItem = {
  id: string;
  text: string;
  authorHandle: string;
  kind: 'like' | 'bookmark';
  articles: {
    title?: string;
    siteName?: string;
    url: string;
    content: string; // markdown
  }[];
};

type Cluster = {
  topic: string;          // short label
  itemIds: string[];
};

type ClusterSummary = {
  topic: string;
  itemIds: string[];
  summary: string;        // 2-4 sentence synthesis
  highlights: string[];   // bullet points
  score?: number;         // set by `rank` node
};

type DigestState = {
  userId: string;
  window: { start: Date; end: Date };
  items: EnrichedItem[];
  clusters?: Cluster[];
  summaries?: ClusterSummary[];
  ranked?: ClusterSummary[];
  markdown?: string;
  usage: { tokensIn: number; tokensOut: number };
  model: string;
};
```

## Graph

```
START → cluster → summarize → rank → compose → END
```

Edges are linear. Failure in any node bubbles to BullMQ, which retries the
whole job per the policy in [jobs.md](./jobs.md). Partial state is not
persisted between attempts in v1.

### Node: `cluster`
- **Input:** `state.items`
- **LLM call:** one. Asks for 3–7 topic clusters covering all items.
- **Output:** `state.clusters`.
- **Prompt outline:** "Group these N items into 3–7 coherent topic clusters. Each cluster has a short label and the list of item IDs that belong to it. Every item id must appear in exactly one cluster. Return JSON."
- **Failure modes handled:** items missing from output → assign to a `Misc` cluster; duplicates → keep first.

### Node: `summarize`
- **Input:** `state.clusters`, `state.items`
- **LLM calls:** one per cluster, fanned out via LangGraph `Send`.
- **Output:** `state.summaries`.
- **Prompt outline:** "Here are the items in cluster `{topic}`: <items + article excerpts>. Write a 2-4 sentence synthesis of what's worth knowing, plus 3-6 bullet highlights. Cite source URLs inline. Return JSON."
- Article content is truncated to a per-item char budget to control tokens.

### Node: `rank`
- **Input:** `state.summaries`
- **LLM call:** one. Scores each cluster on signal/novelty 1-10.
- **Output:** `state.ranked` (sorted desc by score).
- **Prompt outline:** "Score each cluster 1-10 for newsworthiness and signal density for someone whose interests are reflected in the source items themselves. Return JSON."
- v1 does **not** look at prior digests for novelty. That's a v2 enhancement.

### Node: `compose`
- **Input:** `state.ranked`
- **LLM call:** one. Produces final markdown.
- **Output:** `state.markdown`.
- **Prompt outline:** "Compose a personalized digest in markdown. Top section first. Each cluster gets an `##` header, the synthesis paragraph, the bullets, and a `Sources` sub-list of links. Keep it tight."

## LlmProvider interface

```ts
export interface LlmProvider {
  readonly model: string;

  chat(opts: {
    system?: string;
    messages: { role: 'user' | 'assistant'; content: string }[];
    responseFormat?: 'text' | 'json';
    temperature?: number;
    maxTokens?: number;
  }): Promise<{
    content: string;
    usage: { tokensIn: number; tokensOut: number };
  }>;
}
```

Default impl: `OpenRouterProvider` (uses `@langchain/openai` with
`baseURL: 'https://openrouter.ai/api/v1'` and `OPENROUTER_API_KEY`). The
provider is selected via the `LLM_PROVIDER` env var; the factory in
`src/digest/llm/index.ts` returns the matching impl. See
[interfaces.md](./interfaces.md) for the full swap-point contract.

## Token accounting

Each `LlmProvider.chat` call returns usage. The processor accumulates these
into `state.usage` and persists them on the `digests` row. This is the
foundation for future quota / billing work.

## Determinism & testing

- Graph nodes are unit-tested with a stub `LlmProvider` that returns fixed
  payloads. Tests assert the full state transition, not the prompts.
- Prompts live as constants in each node module so they can be diffed in PRs.
- A future issue may add prompt snapshot tests; not in v1.
