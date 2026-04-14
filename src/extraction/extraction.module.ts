import { type DynamicModule, Module } from '@nestjs/common';
import type { Env } from '../config/env';
import type { ArticleExtractor } from './article-extractor.port';
import { FirecrawlExtractor } from './firecrawl.extractor';

/**
 * Wires the extraction module's single seam.
 *
 * Exposes exactly one DI token — `ARTICLE_EXTRACTOR` — backed by the
 * default `FirecrawlExtractor`. The `extract-item` processor (#8) and
 * any future consumer inject the adapter by token, not by class, so
 * swapping it for `ReadabilityExtractor` or a test fake only requires
 * a factory change here.
 *
 * The module is registered with `global: true` so `WorkersModule` can
 * inject `ARTICLE_EXTRACTOR` without re-importing `ExtractionModule`.
 * Same pattern as `IngestionModule` and `AuthModule`.
 */

/**
 * DI token for the `ArticleExtractor` port. Follows the same naming
 * convention as `X_SOURCE` and `X_OAUTH_CLIENT`.
 */
export const ARTICLE_EXTRACTOR = 'ArticleExtractor';

@Module({})
export class ExtractionModule {
  static forRoot(env: Env): DynamicModule {
    const articleExtractorProvider = {
      provide: ARTICLE_EXTRACTOR,
      useFactory: (): ArticleExtractor =>
        new FirecrawlExtractor({
          apiKey: env.FIRECRAWL_API_KEY,
          baseUrl: env.FIRECRAWL_BASE_URL,
        }),
    };

    return {
      module: ExtractionModule,
      global: true,
      providers: [articleExtractorProvider],
      exports: [ARTICLE_EXTRACTOR],
    };
  }
}
