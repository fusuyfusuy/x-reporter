/**
 * DI token for the `LlmProvider` port. Consumers inject the provider
 * via `@Inject(LLM_PROVIDER)` without referencing the concrete class.
 *
 * Lives in its own file to avoid a circular dependency between
 * `llm.module.ts` (which imports `createLlmProvider` from `./index`)
 * and `./index.ts` (which re-exports `LLM_PROVIDER`).
 *
 * Follows the same naming convention as `X_SOURCE` in
 * `src/ingestion/ingestion.module.ts` and `X_OAUTH_CLIENT` in
 * `src/auth/auth.module.ts`.
 */
export const LLM_PROVIDER = 'LlmProvider';
