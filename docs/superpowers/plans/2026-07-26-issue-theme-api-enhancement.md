# Issue Theme API Enhancement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the existing issue-theme APIs with RS80-based theme metrics, search/filter/sort, streaks, related themes, stock sorting, and a once-daily LLM news summary.

**Architecture:** Keep the existing public endpoints and extract deterministic metric calculations into a focused service. Persist daily historical fields in `ThemeDailySnapshot`, persist LLM runs separately in `ThemeAiSummary`, and make the request path read stored summaries only.

**Tech Stack:** NestJS 11, TypeScript 5.9, Prisma 7/PostgreSQL, Jest 30, Axios, existing Redis realtime price cache.

## Global Constraints

- Backend-only change in `/Users/seokjelee/secret/olla-back`.
- LLM generation runs after market close once per trading day, never in a public request.
- A failed or missing LLM call must not fail snapshot persistence or public APIs.
- Search, favorites, and the selected filter combine with AND semantics.
- Use RS 80+ stocks and require at least two eligible stocks for theme exposure.
- Preserve the existing `/issue-theme` and `/issue-theme/:themeCode` routes.
- Write a failing Jest test before each production behavior change.

---

### Task 1: Pure theme metric and streak calculations

**Files:**
- Create: `src/features/issue-theme/theme-metrics.service.ts`
- Create: `src/features/issue-theme/theme-metrics.service.spec.ts`
- Modify: `src/features/issue-theme/issue-theme.module.ts`

**Interfaces:**
- Produces `ThemeMetricInput`, `ThemeMetricResult`, `ThemeStreak`, and `ThemeMetricsService`.
- `calculateDailyMetric(stocks, history)` returns RS80-filtered counts, averages, short-term RS, momentum, and streak.
- `calculateRelatedThemes(current, candidates)` returns at most three Jaccard-ranked related themes.

- [ ] **Step 1: Write failing tests for RS80 eligibility and averages**

Test that RS 79 is excluded, duplicate stock codes are deduplicated, fewer than two eligible stocks returns `isEligible: false`, and averages are rounded to two decimals.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `pnpm test -- theme-metrics.service.spec.ts --runInBand`

Expected: FAIL because `ThemeMetricsService` does not exist.

- [ ] **Step 3: Implement the minimal daily metric calculator**

Create explicit input/output types and implement:

```ts
calculateDailyMetric(stocks: ThemeMetricStock[], history: ThemeMetricHistory[]): ThemeMetricResult
```

Use a map keyed by `stockCode`, filter `rsScore >= 80`, calculate `rsScore`, `changeRate`, `risingCount`, `newHighCount`, and preserve `stockCount` versus `eligibleStockCount`.

- [ ] **Step 4: Add failing tests for short-term RS, 63-day momentum, and missing history**

Require three complete trade dates for `shortTermRs`. Return `null` for both history fields when one date is absent. Calculate momentum as the three-day theme average minus the available 63-trading-day theme average.

- [ ] **Step 5: Run RED, implement history calculations, and run GREEN**

Run the same focused command before and after implementation. Expected final result: all tests in the file pass.

- [ ] **Step 6: Add failing tests for streak transitions**

Cover strong continuation, weak continuation, direction reversal, neutral reset, strong tone change at day four, and hidden one-day weak state.

- [ ] **Step 7: Implement `calculateStreak` and verify GREEN**

Use `STRONG >= 0.5`, `WEAK <= -0.5`, and `NEUTRAL` otherwise. Return `tone` as `RED`, `ORANGE`, `BLUE`, or `null` according to the design.

- [ ] **Step 8: Add failing related-theme tests and implement Jaccard sorting**

Require two shared RS80 stock codes and similarity at least `0.10`; exclude the current theme; sort similarity then RS descending; slice to three.

- [ ] **Step 9: Run focused tests and commit**

```bash
pnpm test -- theme-metrics.service.spec.ts --runInBand
git add src/features/issue-theme/theme-metrics.service.ts src/features/issue-theme/theme-metrics.service.spec.ts src/features/issue-theme/issue-theme.module.ts
git commit -m "feat: add issue theme metric calculations"
```

### Task 2: Persist enhanced daily theme snapshots

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/<timestamp>_enhance_issue_theme_snapshots/migration.sql`
- Create: `src/features/issue-theme/issue-theme.snapshot.spec.ts`
- Modify: `src/features/issue-theme/issue-theme.service.ts`

**Interfaces:**
- Consumes `ThemeMetricsService.calculateDailyMetric` and `calculateStreak`.
- Produces snapshot fields `shortTermRs`, `momentum`, `newHighCount`, `streakDirection`, and `streakDays`.

- [ ] **Step 1: Write a failing snapshot service test**

Mock Prisma, realtime cache, and the metrics service. Assert `saveThemeSnapshot()` persists the enhanced fields and commits the snapshot before any optional post-snapshot work.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `pnpm test -- issue-theme.snapshot.spec.ts --runInBand`

Expected: FAIL because enhanced fields are not written.

- [ ] **Step 3: Add Prisma fields and SQL migration**

Add nullable decimals for historical calculations, a non-negative integer new-high count, direction text, and streak days with zero defaults. Keep existing columns intact.

- [ ] **Step 4: Update snapshot aggregation minimally**

Load the required recent daily metrics in batches, delegate calculation to `ThemeMetricsService`, and write all snapshot rows in one delete/create transaction for the trade date.

- [ ] **Step 5: Update backfill SQL with equivalent formulas**

Extend the existing CTE-based backfill so historical and scheduled snapshots produce the same fields. Use PostgreSQL window/aggregate CTEs by trading date; do not loop one query per theme.

- [ ] **Step 6: Verify focused test, Prisma schema, and commit**

```bash
pnpm test -- issue-theme.snapshot.spec.ts --runInBand
pnpm exec prisma validate
git add prisma/schema.prisma prisma/migrations src/features/issue-theme/issue-theme.service.ts src/features/issue-theme/issue-theme.snapshot.spec.ts
git commit -m "feat: persist enhanced issue theme snapshots"
```

### Task 3: Typed list and detail query contracts

**Files:**
- Create: `src/features/issue-theme/dto/issue-theme-list-query.dto.ts`
- Create: `src/features/issue-theme/dto/issue-theme-detail-query.dto.ts`
- Create: `src/features/issue-theme/dto/issue-theme-response.dto.ts`
- Create: `src/features/issue-theme/dto/issue-theme-query.dto.spec.ts`
- Modify: `src/features/issue-theme/issue-theme.controller.ts`

**Interfaces:**
- Produces `IssueThemeListQueryDto` and `IssueThemeDetailQueryDto` passed as complete query objects to the service.
- List enums: `view`, `filter`, `sort`; detail enum: `stockSort`.

- [ ] **Step 1: Write failing DTO transformation and validation tests**

Test defaults, boolean conversion for `favoritesOnly`, integer bounds, valid enums, and rejected enum values.

- [ ] **Step 2: Run RED and add DTOs with class-validator/class-transformer**

Run: `pnpm test -- issue-theme-query.dto.spec.ts --runInBand`

Expected first run: FAIL on missing DTO imports. Final run: PASS.

- [ ] **Step 3: Change controller signatures to typed query objects**

Keep routes unchanged. Apply `OptionalJwtAuthGuard` to the list route so favorites and `isFavorite` can be resolved when a token is present. Reject unauthenticated `favoritesOnly=true` in the service with `UnauthorizedException`.

- [ ] **Step 4: Run controller/DTO tests and commit**

```bash
pnpm test -- issue-theme-query.dto.spec.ts --runInBand
git add src/features/issue-theme/dto src/features/issue-theme/issue-theme.controller.ts
git commit -m "feat: add typed issue theme query contracts"
```

### Task 4: Search, filters, counts, sorting, and favorites in the list API

**Files:**
- Create: `src/features/issue-theme/issue-theme.list.spec.ts`
- Modify: `src/features/issue-theme/issue-theme.service.ts`

**Interfaces:**
- Consumes `IssueThemeListQueryDto` and optional `userId`.
- Produces `{ items, filterCounts, pagination, updatedAt }`.

- [ ] **Step 1: Write a failing list test for AND semantics**

Provide fixtures where search, favorites, and `changeRate5` each remove different rows. Assert only the intersection remains and filter counts use the search+favorite base population.

- [ ] **Step 2: Run RED and implement the list pipeline**

Run: `pnpm test -- issue-theme.list.spec.ts --runInBand`

Implement explicit phases: load → eligible themes → search → favorites → compute counts → selected filter → sort → paginate.

- [ ] **Step 3: Add failing tests for empty results and all sort modes**

Assert empty `items` with `200` semantics, stable tie breakers, and `previousRank` nulls last.

- [ ] **Step 4: Implement sorting and pagination metadata**

Return `page`, `display`, `total`, and `totalPages`; preserve a single `updatedAt` matching the newest source data.

- [ ] **Step 5: Add failing auth and heatmap/search conflict tests**

Assert unauthenticated favorites produces `UnauthorizedException` and heatmap with a non-empty search produces `BadRequestException`.

- [ ] **Step 6: Implement validation, run GREEN, and commit**

```bash
pnpm test -- issue-theme.list.spec.ts --runInBand
git add src/features/issue-theme/issue-theme.service.ts src/features/issue-theme/issue-theme.list.spec.ts
git commit -m "feat: enhance issue theme list filters"
```

### Task 5: Detail metrics, stock sorting, and related themes

**Files:**
- Create: `src/features/issue-theme/issue-theme.detail.spec.ts`
- Modify: `src/features/issue-theme/issue-theme.service.ts`

**Interfaces:**
- Consumes `IssueThemeDetailQueryDto` and `ThemeMetricsService.calculateRelatedThemes`.
- Produces enhanced detail fields, sorted stocks, and `relatedThemes`.

- [ ] **Step 1: Write failing tests for every stock sort**

Use a common fixture and assert `rs`, `shortTermRs`, `changeRate`, `tradingValue`, `previousRatio`, and `newHigh` order independently, with nulls last and stock code as stable tie breaker.

- [ ] **Step 2: Run RED and implement stock row fields and sorting**

Run: `pnpm test -- issue-theme.detail.spec.ts --runInBand`

Add `shortTermRs`, `previousTradingValueRatio`, `newHighRate`, and `isNewHigh` without removing current response fields.

- [ ] **Step 3: Write failing related-theme integration tests**

Assert candidate inputs come from RS80 memberships, current theme is excluded, and the service response includes no more than three items.

- [ ] **Step 4: Implement related-theme loading and response composition**

Batch load memberships and snapshots. Do not perform a database query inside the candidate loop.

- [ ] **Step 5: Verify detail tests and commit**

```bash
pnpm test -- issue-theme.detail.spec.ts --runInBand
git add src/features/issue-theme/issue-theme.service.ts src/features/issue-theme/issue-theme.detail.spec.ts
git commit -m "feat: enhance issue theme details"
```

### Task 6: LLM summary persistence and provider boundary

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/<timestamp>_add_theme_ai_summaries/migration.sql`
- Create: `src/features/issue-theme/llm/llm-client.interface.ts`
- Create: `src/features/issue-theme/llm/openai-llm.client.ts`
- Create: `src/features/issue-theme/theme-ai-summary.service.ts`
- Create: `src/features/issue-theme/theme-ai-summary.service.spec.ts`
- Modify: `src/features/issue-theme/issue-theme.module.ts`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- `LlmClient.generateThemeSummary(input): Promise<{ summary: string; sourceIndexes: number[]; model: string }>`.
- `ThemeAiSummaryService.generateForTradeDate(tradeDate, limit)` returns target/success/failure/skipped counts and failed theme codes.

- [ ] **Step 1: Write failing tests for news deduplication and structured output validation**

Test duplicate title/URL removal, missing source indexes, invalid JSON, and a valid two-sentence result.

- [ ] **Step 2: Run RED and implement the provider-independent service**

Run: `pnpm test -- theme-ai-summary.service.spec.ts --runInBand`

Inject `LlmClient` through a module token. Reuse a shared news-search method extracted from the existing Naver news code.

- [ ] **Step 3: Add failing tests for per-theme failure isolation and prior-summary fallback**

Make one theme reject and another succeed. Assert the second saves `SUCCESS`, the first saves failure metadata, and public lookup still returns the previous successful summary.

- [ ] **Step 4: Implement persistence and concurrency limiting**

Persist one row per theme/trade date. Use a small worker pool configured by `THEME_AI_CONCURRENCY`, default 2. Skip generation when `OPENAI_API_KEY` is absent.

- [ ] **Step 5: Implement the OpenAI adapter with structured JSON**

Add the official OpenAI dependency and keep model selection in `OPENAI_THEME_SUMMARY_MODEL`. Set timeout, validate parsed output, and never expose the API key in logs.

- [ ] **Step 6: Validate Prisma, run focused tests, and commit**

```bash
pnpm test -- theme-ai-summary.service.spec.ts --runInBand
pnpm exec prisma validate
git add package.json pnpm-lock.yaml prisma src/features/issue-theme
git commit -m "feat: add daily AI theme summaries"
```

### Task 7: Daily orchestration and admin regeneration APIs

**Files:**
- Create: `src/features/issue-theme/issue-theme.ai-controller.spec.ts`
- Modify: `src/features/issue-theme/issue-theme.controller.ts`
- Modify: `src/features/issue-theme/issue-theme.service.ts`
- Modify: `src/features/issue-theme/theme-ai-summary.service.ts`

**Interfaces:**
- Adds admin endpoints `/issue-theme/ai-summary/generate` and `/issue-theme/ai-summary/:themeCode/regenerate`.
- Snapshot scheduler invokes AI generation only after snapshot persistence resolves.

- [ ] **Step 1: Write a failing orchestration test**

Assert snapshot persistence resolves before AI generation begins and an AI rejection does not reject `saveThemeSnapshot()`.

- [ ] **Step 2: Run RED and implement post-snapshot invocation**

Run: `pnpm test -- issue-theme.ai-controller.spec.ts --runInBand`

Log AI failures separately. Do not wrap snapshot and LLM work in the same transaction.

- [ ] **Step 3: Write failing admin route tests**

Cover date parsing, limit bounds, single-theme regeneration, and admin guard metadata.

- [ ] **Step 4: Implement admin routes and summary lookup in detail**

Return batch counts from admin routes. Add `aiSummary`, `aiSummaryUpdatedAt`, and `aiSummarySources` from the latest successful row to the detail response.

- [ ] **Step 5: Run focused tests and commit**

```bash
pnpm test -- issue-theme.ai-controller.spec.ts --runInBand
git add src/features/issue-theme
git commit -m "feat: schedule and manage theme summaries"
```

### Task 8: Swagger, regression verification, and API samples

**Files:**
- Modify: `docs/api/issue-theme-watchlist-auth.md`
- Modify: `docs/api-requests.http`
- Modify: `swagger.json` only through the repository Swagger generation path if available

**Interfaces:**
- Documents all public and admin contracts delivered by Tasks 1–7.

- [ ] **Step 1: Update API documentation and sample requests**

Include list queries, filter count semantics, detail stock sorts, null AI behavior, and both admin regeneration requests.

- [ ] **Step 2: Run all issue-theme tests**

```bash
pnpm test -- issue-theme --runInBand
```

Expected: all issue-theme suites pass with zero failures.

- [ ] **Step 3: Validate Prisma and compile**

```bash
pnpm exec prisma validate
pnpm build
```

Expected: both commands exit 0.

- [ ] **Step 4: Inspect the final diff and schema migration**

```bash
git diff --check
git status --short
git diff HEAD~7 -- src/features/issue-theme prisma docs/api package.json pnpm-lock.yaml
```

Confirm no secrets, generated noise, unrelated files, or request-time LLM calls are present.

- [ ] **Step 5: Commit documentation**

```bash
git add docs/api/issue-theme-watchlist-auth.md docs/api-requests.http swagger.json
git commit -m "docs: document enhanced issue theme APIs"
```
