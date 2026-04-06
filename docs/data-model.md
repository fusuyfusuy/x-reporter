# Data model (Appwrite)

Database id: `xreporter`

All `id` fields are Appwrite document IDs unless noted. All timestamps are
ISO-8601 strings stored as Appwrite datetime attributes.

## `users`

| Field               | Type     | Notes                                            |
|---------------------|----------|--------------------------------------------------|
| `xUserId`           | string   | X numeric user id, unique                        |
| `handle`            | string   | X handle without `@`                             |
| `pollIntervalMin`   | integer? | Optional at the DB level so the documented default takes effect. Default 60. Min 5. |
| `digestIntervalMin` | integer? | Optional at the DB level so the documented default takes effect. Default 1440 (daily). Min 15. |
| `lastLikeCursor`    | string?  | Pagination cursor returned by X likes endpoint   |
| `lastBookmarkCursor`| string?  | Pagination cursor for bookmarks                  |
| `status`            | enum     | `active` \| `auth_expired` \| `paused`           |
| `createdAt`         | datetime | -                                                |

**Indexes**
- `xUserId` (unique)
- `status`

## `tokens`

| Field          | Type     | Notes                                                   |
|----------------|----------|---------------------------------------------------------|
| `userId`       | string   | FK → `users.$id`, unique                                |
| `accessToken`  | string   | AES-256-GCM ciphertext (base64), see [configuration.md](./configuration.md) |
| `refreshToken` | string   | AES-256-GCM ciphertext (base64)                         |
| `expiresAt`    | datetime | When the access token expires                           |
| `scope`        | string   | Space-separated scopes granted                          |

**Indexes**
- `userId` (unique)

## `items`

A liked or bookmarked tweet captured from X.

| Field          | Type     | Notes                                                   |
|----------------|----------|---------------------------------------------------------|
| `userId`       | string   | FK → `users.$id`                                        |
| `xTweetId`     | string   | Tweet snowflake id                                      |
| `kind`         | enum     | `like` \| `bookmark`                                    |
| `text`         | string   | Tweet text                                              |
| `authorHandle` | string   | Author X handle                                         |
| `urls`         | string[] | Expanded URLs from `entities.urls` + text scraping      |
| `fetchedAt`    | datetime | When we ingested it                                     |
| `enriched`     | boolean? | Optional at the DB level so the documented default (`false`) takes effect. True once `extract-item` finishes for all `urls`. |

**Indexes**
- `userId, xTweetId` (unique compound)
- `userId, fetchedAt` (descending)
- `userId, enriched`

## `articles`

Cleaned content for a single URL referenced by an item.

| Field          | Type     | Notes                                                   |
|----------------|----------|---------------------------------------------------------|
| `itemId`       | string   | FK → `items.$id`                                        |
| `url`          | string   | The URL we were given                                   |
| `canonicalUrl` | string?  | Resolved canonical URL (after redirects + `<link rel=canonical>`) |
| `title`        | string?  | Article title                                           |
| `byline`       | string?  | Author byline                                           |
| `siteName`     | string?  | Publisher                                               |
| `content`      | string   | Cleaned markdown body                                   |
| `extractedAt`  | datetime | -                                                       |
| `extractor`    | string   | Identifier of the impl that produced it (e.g. `firecrawl`) |

**Indexes**
- `itemId`
- `canonicalUrl`

## `digests`

| Field         | Type     | Notes                                                   |
|---------------|----------|---------------------------------------------------------|
| `userId`      | string   | FK → `users.$id`                                        |
| `windowStart` | datetime | Inclusive lower bound of source items                   |
| `windowEnd`   | datetime | Exclusive upper bound                                   |
| `markdown`    | string   | Final digest body                                       |
| `itemIds`     | string[] | Source items used                                       |
| `model`       | string   | Model identifier (e.g. `anthropic/claude-sonnet-4.5`)   |
| `tokensIn`    | integer  | Total prompt tokens                                     |
| `tokensOut`   | integer  | Total completion tokens                                 |
| `createdAt`   | datetime | -                                                       |

**Indexes**
- `userId, createdAt` (descending)

## Setup

`scripts/setup-appwrite.ts` is idempotent: it ensures the database, every
collection, every attribute, and every index exists. Re-running it after a
schema change is the supported migration path for v1.
