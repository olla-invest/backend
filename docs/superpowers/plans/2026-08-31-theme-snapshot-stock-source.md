# Stock-Snapshot-Sourced Theme Aggregation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make issue-theme, watchlist, and recommendation theme ranks and counts derive from one finalized stock rank snapshot.

**Architecture:** Extend `stock_current_rank_snapshots` so a single `trade_date + snapshot_time` contains every stock value needed for theme aggregation. Add a focused theme snapshot service that selects exactly one stock snapshot, aggregates it with theme membership, persists the source timestamp, and serves theme/stock snapshot reads; public APIs stop recomputing theme state from realtime cache and daily metrics.

**Tech Stack:** NestJS, TypeScript, Prisma, PostgreSQL, Jest, pnpm

**Spec:** `docs/superpowers/specs/2026-08-31-theme-snapshot-stock-source-design.md`

## Global Constraints

- `stock_current_rank_snapshots` is the only source of stock price, RS, eligibility, change, trading-value, and new-high values used in theme aggregation.
- Every theme snapshot uses one exact `trade_date + snapshot_time`; rows from different snapshots must never be mixed.
- Theme membership and metadata may come from `stock_themes` and `themes`; no stock value may be supplemented from another table during theme aggregation or API reads.
- RS 80 is a request filter, not a base eligibility rule.
- Existing API paths, response field names, and response field types remain unchanged.
- No fallback to realtime cache or `stock_daily_metrics` is allowed when a complete theme snapshot is absent.
- All production changes follow RED-GREEN-REFACTOR and are committed separately by task.

---

## File Structure

- `prisma/schema.prisma`: declares the additional stock/theme snapshot columns.
- `prisma/migrations/20260831_source_themes_from_stock_snapshots/migration.sql`: adds nullable columns and indexes without rewriting existing rows.
- `src/features/real-time-chart/current-rank.service.ts`: captures the complete stock snapshot payload.
- `src/features/real-time-chart/current-rank.service.spec.ts`: proves snapshot payload derivation and persistence.
- `src/features/issue-theme/theme-snapshot.service.ts`: owns stock-snapshot selection, theme aggregation, persistence, and snapshot-backed read models.
- `src/features/issue-theme/theme-snapshot.service.spec.ts`: proves single-source aggregation and deterministic ranks/counts.
- `src/features/issue-theme/issue-theme.module.ts`: registers and exports the new service.
- `src/features/real-time-chart/data-scheduler.service.ts`: emits a completion event only after stock snapshot finalization.
- `src/features/real-time-chart/data-scheduler.service.spec.ts`: proves batch order and failure behavior.
- `src/features/issue-theme/issue-theme.service.ts`: consumes theme/stock snapshot read models instead of recomputing current theme state.
- `src/features/issue-theme/issue-theme.list.spec.ts`: covers snapshot-backed list behavior.
- `src/features/issue-theme/issue-theme.detail.spec.ts`: covers snapshot-backed detail behavior.
- `src/features/watchlist/watchlist.service.ts`: consumes the same theme snapshot current values for favorites and recommendations.
- `src/features/watchlist/watchlist.service.spec.ts`: reproduces and prevents the OLED mismatch.

---

### Task 1: Add traceable snapshot schema

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260831_source_themes_from_stock_snapshots/migration.sql`

**Interfaces:**
- Produces: nullable Prisma fields `priceChangeRate`, `tradingValue`, `previousTradingValueRatio`, `isNewHigh`, and `stockSnapshotTime`.
- Consumes: existing `StockCurrentRankSnapshot` and `ThemeDailySnapshot` models.

- [ ] **Step 1: Add the migration SQL first**

```sql
ALTER TABLE "stock_current_rank_snapshots"
  ADD COLUMN "price_change_rate" DECIMAL(10, 4),
  ADD COLUMN "trading_value" BIGINT,
  ADD COLUMN "previous_trading_value_ratio" DECIMAL(12, 4),
  ADD COLUMN "is_new_high" BOOLEAN;

ALTER TABLE "theme_daily_snapshots"
  ADD COLUMN "stock_snapshot_time" TIMESTAMP;

CREATE INDEX "idx_theme_snapshot_stock_source"
  ON "theme_daily_snapshots"("snapshot_date", "stock_snapshot_time");
```

- [ ] **Step 2: Update Prisma models with exact mappings**

```prisma
// StockCurrentRankSnapshot
priceChangeRate           Decimal? @map("price_change_rate") @db.Decimal(10, 4)
tradingValue              BigInt?  @map("trading_value")
previousTradingValueRatio Decimal? @map("previous_trading_value_ratio") @db.Decimal(12, 4)
isNewHigh                 Boolean? @map("is_new_high")

// ThemeDailySnapshot
stockSnapshotTime DateTime? @map("stock_snapshot_time")
```

- [ ] **Step 3: Generate Prisma client and validate schema**

Run: `pnpm prisma generate && pnpm exec prisma validate`

Expected: both commands exit 0.

- [ ] **Step 4: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20260831_source_themes_from_stock_snapshots/migration.sql
git commit -m "feat: trace theme snapshots to stock snapshots"
```

---

### Task 2: Capture complete stock snapshot facts

**Files:**
- Modify: `src/features/real-time-chart/current-rank.service.ts`
- Modify: `src/features/real-time-chart/current-rank.service.spec.ts`

**Interfaces:**
- Consumes: `CurrentPriceResolver.getUsableRealtimePrice`, `RealtimePriceCacheService`, daily metric fields, and the previous trading-value snapshot query.
- Produces: `CurrentRankRow` with `priceChangeRate: number | null`, `tradingValue: bigint | null`, `previousTradingValueRatio: number | null`, and `isNewHigh: boolean`.

- [ ] **Step 1: Write a failing test for the stock snapshot payload**

Add a test that supplies one daily metric with `close_price=100`, `price_change_rate_1d=4`, `trading_value=1000`, `is_new_high=true`, and no usable realtime price. Assert the SQL parameter list persists `4`, `1000n`, the supplied previous ratio, and `true` beside the existing price/RS fields.

```ts
expect(executeParams).toEqual(expect.arrayContaining([4, 1000n, 2.5, true]));
```

The production change that makes this test fail is omission of any theme-required fact from the stock snapshot insert.

- [ ] **Step 2: Run RED**

Run: `pnpm test -- current-rank.service.spec.ts --runInBand`

Expected: FAIL because the insert does not contain the four new values.

- [ ] **Step 3: Extend `MetricRow` and `CurrentRankRow`**

Select and normalize these daily metric columns:

```sql
price_change_rate_1d::text,
trading_value,
is_new_high
```

Derive the snapshot values once:

```ts
const priceChangeRate = realtimePrice
  ? realtimePrice.changeRate
  : metric.price_change_rate_1d == null ? null : Number(metric.price_change_rate_1d);
const tradingValue = realtimePrice?.accAmount && realtimePrice.accAmount > 0
  ? BigInt(Math.trunc(realtimePrice.accAmount))
  : metric.trading_value;
const isNewHigh = highPrice52w != null && currentPrice >= highPrice52w;
```

Load `previousTradingValueRatio` in one batch before `buildRankRows`; do not query once per stock. Pass a `Map<string, number | null>` into `buildRankRows`.

- [ ] **Step 4: Persist new columns in insert and conflict update**

Extend both the `INSERT` column/value list and `ON CONFLICT DO UPDATE` clause. Preserve nullable values; do not replace missing ratios with zero.

- [ ] **Step 5: Run GREEN**

Run: `pnpm test -- current-rank.service.spec.ts --runInBand`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/features/real-time-chart/current-rank.service.ts src/features/real-time-chart/current-rank.service.spec.ts
git commit -m "feat: persist theme facts in stock rank snapshots"
```

---

### Task 3: Build theme snapshots from one stock snapshot

**Files:**
- Create: `src/features/issue-theme/theme-snapshot.service.ts`
- Create: `src/features/issue-theme/theme-snapshot.service.spec.ts`
- Modify: `src/features/issue-theme/issue-theme.module.ts`

**Interfaces:**
- Consumes: `PrismaService` and one selected stock snapshot.
- Produces:
  - `buildDailySnapshot(tradeDate: Date): Promise<{ saved: number; tradeDate: string; stockSnapshotTime: string }>`
  - `getLatestThemeItems(themeCodes?: number[]): Promise<Map<number, ThemeSnapshotItem>>`
  - `getThemeStocks(themeCode: number, tradeDate: Date, stockSnapshotTime: Date): Promise<ThemeSnapshotStock[]>`

Define exported read types:

```ts
export interface ThemeSnapshotItem {
  themeCode: number;
  rank: number;
  previousRank: number | null;
  risingCount: number;
  totalCount: number;
  upCount: number;
  flatCount: number;
  downCount: number;
  risingRatio: number;
  avgChangeRate: number;
  avgRsScore: number;
  newHighCount: number;
  stockSnapshotTime: Date;
  snapshotDate: Date;
}

export interface ThemeSnapshotStock {
  stockCode: string;
  currentRank: number;
  currentPrice: number;
  relativeStrengthScore: number;
  priceChangeRate: number;
  tradingValue: bigint | null;
  previousTradingValueRatio: number | null;
  isNewHigh: boolean;
}
```

- [ ] **Step 1: Write failing aggregation tests**

Use controlled query results containing two snapshot times. Assert the service:

```ts
expect(result.stockSnapshotTime).toBe('2026-08-10T06:50:00.000Z');
expect(savedOled).toMatchObject({
  rank: 34,
  totalCount: 7,
  risingCount: 5,
  upCount: 5,
  flatCount: 0,
  downCount: 2,
});
```

Include an RS 73 row and assert it is counted when `passed_dynamic_filters=true`. Include a later/earlier snapshot row and assert it is not mixed into totals.

- [ ] **Step 2: Run RED**

Run: `pnpm test -- theme-snapshot.service.spec.ts --runInBand`

Expected: FAIL because `ThemeSnapshotService` does not exist.

- [ ] **Step 3: Implement exact-source selection**

Select the latest snapshot time for the requested date, then load only rows matching both keys:

```sql
WHERE trade_date = $1::date
  AND snapshot_time = $2::timestamp
  AND passed_dynamic_filters = TRUE
  AND current_rank IS NOT NULL
  AND price_change_rate IS NOT NULL
```

If no source exists, throw an error containing the trade date. Do not query `stock_daily_metrics` or realtime cache.

- [ ] **Step 4: Aggregate and rank deterministically**

Deduplicate by `themeCode + stockCode`. Calculate counts using literal boundaries `> 0`, `= 0`, and `< 0`, matching the issue-theme detail's rise/flat/fall display. Sort themes by `avgRsScore DESC`, `avgChangeRate DESC`, `themeCode ASC`; assign `index + 1` ranks.

- [ ] **Step 5: Persist atomically**

Within one Prisma transaction, delete the requested snapshot date and create all theme rows with the same `stockSnapshotTime`. Persist no partial theme set.

- [ ] **Step 6: Implement snapshot-backed reads**

`getLatestThemeItems` selects one latest theme snapshot date, loads previous ranks from the prior date, and returns a map. `getThemeStocks` joins only theme membership and the exact stock snapshot key.

- [ ] **Step 7: Register and export service**

Add `ThemeSnapshotService` to `providers` and `exports` in `IssueThemeModule`.

- [ ] **Step 8: Run GREEN**

Run: `pnpm test -- theme-snapshot.service.spec.ts --runInBand`

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/features/issue-theme/theme-snapshot.service.ts src/features/issue-theme/theme-snapshot.service.spec.ts src/features/issue-theme/issue-theme.module.ts
git commit -m "feat: aggregate themes from stock snapshots"
```

---

### Task 4: Trigger theme snapshots after stock finalization

**Files:**
- Modify: `src/features/real-time-chart/data-scheduler.service.ts`
- Modify: `src/features/real-time-chart/data-scheduler.service.spec.ts`
- Modify: `src/features/issue-theme/theme-snapshot.service.ts`
- Modify: `src/features/issue-theme/theme-snapshot.service.spec.ts`
- Modify: `src/features/issue-theme/issue-theme.service.ts`

**Interfaces:**
- Produces event: `stock-ranks.finalized` payload `{ tradeDate: string }`.
- Consumes event: `ThemeSnapshotService.handleStockRanksFinalized(payload): Promise<void>`.

- [ ] **Step 1: Write failing batch-order tests**

Update the scheduler test to expect:

```ts
expect(order).toEqual(['metrics', 'snapshot', 'finalize', 'theme-event']);
```

Add a rejection case where `finalizeDailyCurrentRank` throws and assert `theme-event` is absent.

- [ ] **Step 2: Run RED**

Run: `pnpm test -- data-scheduler.service.spec.ts --runInBand`

Expected: FAIL because no completion event is emitted.

- [ ] **Step 3: Emit an awaited completion event**

Inject `EventEmitter2` if it is not already available and call:

```ts
await this.eventEmitter.emitAsync('stock-ranks.finalized', {
  tradeDate: tradeDate.toISOString().slice(0, 10),
});
```

Emit only after `finalizeDailyCurrentRank` resolves.

- [ ] **Step 4: Add the theme listener**

```ts
@OnEvent('stock-ranks.finalized')
async handleStockRanksFinalized({ tradeDate }: { tradeDate: string }) {
  await this.buildDailySnapshot(new Date(`${tradeDate}T00:00:00.000Z`));
}
```

Remove the independent `@Cron('50 15 * * 1-5')` theme snapshot path so two orchestrators cannot race.

- [ ] **Step 5: Run GREEN**

Run: `pnpm test -- data-scheduler.service.spec.ts theme-snapshot.service.spec.ts --runInBand`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/features/real-time-chart/data-scheduler.service.ts src/features/real-time-chart/data-scheduler.service.spec.ts src/features/issue-theme/theme-snapshot.service.ts src/features/issue-theme/theme-snapshot.service.spec.ts src/features/issue-theme/issue-theme.service.ts
git commit -m "feat: sequence theme snapshots after stock ranks"
```

---

### Task 5: Switch issue-theme APIs to snapshot reads

**Files:**
- Modify: `src/features/issue-theme/issue-theme.service.ts`
- Modify: `src/features/issue-theme/issue-theme.list.spec.ts`
- Modify: `src/features/issue-theme/issue-theme.detail.spec.ts`

**Interfaces:**
- Consumes: `ThemeSnapshotService.getLatestThemeItems` and `ThemeSnapshotService.getThemeStocks`.
- Produces: unchanged issue-theme list and detail response contracts.

- [ ] **Step 1: Write failing API service tests**

Provide a theme snapshot fixture with rank 34 and seven exact-source stocks. Assert list and detail both return rank 34 and counts from that fixture. Make Prisma daily metrics and realtime cache throw if called for current theme rank/count/stock facts.

```ts
expect(listItem).toMatchObject({ rank: 34, totalCount: 7, risingCount: 5 });
expect(detail).toMatchObject({ rank: 34, totalCount: 7, risingCount: 5 });
expect(detail.stocks).toHaveLength(7);
```

- [ ] **Step 2: Run RED**

Run: `pnpm test -- issue-theme.list.spec.ts issue-theme.detail.spec.ts --runInBand`

Expected: FAIL because current methods recompute from daily metrics/realtime cache.

- [ ] **Step 3: Replace current theme list aggregation**

Inject `ThemeSnapshotService`. Build list items from its latest map; apply search, favorites, RS80, momentum, stock-count, change-rate, and new-high request filters only after loading the canonical items. Do not re-rank after search or filtering; preserve canonical `rank`.

- [ ] **Step 4: Replace detail header and stock source**

Load the selected `ThemeSnapshotItem`, then call `getThemeStocks` with its exact `snapshotDate` and `stockSnapshotTime`. Apply only requested stock sorting and display slicing.

- [ ] **Step 5: Remove obsolete recomputation paths**

Delete current-rank/count calls that read realtime cache or daily metrics. Retain historical analytics only when they consume persisted theme snapshots. Keep `getFilteredMetrics` only if another non-theme-snapshot administrative operation still needs it; otherwise remove it and its direct test.

- [ ] **Step 6: Run GREEN**

Run: `pnpm test -- issue-theme.list.spec.ts issue-theme.detail.spec.ts --runInBand`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/features/issue-theme/issue-theme.service.ts src/features/issue-theme/issue-theme.list.spec.ts src/features/issue-theme/issue-theme.detail.spec.ts
git commit -m "refactor: serve issue themes from snapshots"
```

---

### Task 6: Switch watchlist and recommendations to the same snapshot

**Files:**
- Create: `src/features/watchlist/watchlist.service.spec.ts`
- Modify: `src/features/watchlist/watchlist.service.ts`

**Interfaces:**
- Consumes: `IssueThemeService.getCurrentThemeRankMap`, now backed by `ThemeSnapshotService`.
- Produces: unchanged watchlist themes, highlights, and recommendations response contracts.

- [ ] **Step 1: Write the OLED regression test**

Set legacy Prisma theme snapshot mocks to rank 4/count 3 and canonical issue-theme snapshot mocks to rank 34/count 7. Assert recommendations ignore the legacy candidate values and return:

```ts
expect(result.recommendedTheme).toMatchObject({
  themeName: 'OLED(유기 발광 다이오드)',
  rank: 34,
  totalCount: 7,
  risingCount: 5,
  upCount: 5,
  flatCount: 0,
  downCount: 2,
});
```

The production regression this catches is direct use of `themeDailySnapshot.findFirst` for current recommendation values.

- [ ] **Step 2: Run RED**

Run: `pnpm test -- watchlist.service.spec.ts --runInBand`

Expected: FAIL with rank 4/count 3.

- [ ] **Step 3: Select candidates and build results from canonical values**

Use the canonical map for candidate ordering and current fields. Query the previous theme snapshot only for `prevRank`; never use it for current rank or counts.

- [ ] **Step 4: Apply the same rule to favorites/highlights**

Ensure `getWatchlistThemes`, theme highlights, and recommendations all call the same canonical map. Remove current-field reads from `themeDailySnapshot` outside `ThemeSnapshotService`.

- [ ] **Step 5: Run GREEN**

Run: `pnpm test -- watchlist.service.spec.ts --runInBand`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/features/watchlist/watchlist.service.ts src/features/watchlist/watchlist.service.spec.ts
git commit -m "fix: align watchlist theme snapshot values"
```

---

### Task 7: Rebuild snapshots safely and verify the pipeline

**Files:**
- Modify: `src/features/real-time-chart/current-rank.service.ts`
- Modify: `src/features/real-time-chart/current-rank.service.spec.ts`
- Modify: `src/features/issue-theme/issue-theme.controller.ts`
- Modify: `src/features/issue-theme/issue-theme.controller.spec.ts`
- Modify: `src/features/issue-theme/theme-snapshot.service.ts`
- Modify: `src/features/issue-theme/theme-snapshot.service.spec.ts`
- Modify: `docs/API_SPEC.md`

**Interfaces:**
- Produces: `CurrentRankService.rebuildClosingSnapshot(tradeDate: Date): Promise<{ success: boolean; count: number; rankedCount: number; tradeDate: string; snapshotTime: string | null }>`.
- Produces: admin backfill method `backfillFromStockSnapshots(days: number): Promise<{ requestedDays: number; rebuiltDates: string[]; skippedDates: string[] }>`.
- Consumes: daily metrics only while reconstructing the canonical stock snapshot; theme rebuilding consumes only the reconstructed stock snapshot.

- [ ] **Step 1: Write failing backfill tests**

Create three dates: two with reconstructable daily metrics and one without. Assert stock snapshots are rebuilt first, theme snapshots are created only for the two successful dates, and the missing date is returned in `skippedDates`. Assert `ThemeSnapshotService` never queries `stock_daily_metrics` directly.

- [ ] **Step 2: Run RED**

Run: `pnpm test -- theme-snapshot.service.spec.ts issue-theme.controller.spec.ts --runInBand`

Expected: FAIL because the closing-stock-snapshot rebuild and theme backfill methods do not exist.

- [ ] **Step 3: Implement historical closing stock snapshot reconstruction**

Add `rebuildClosingSnapshot(tradeDate)` to `CurrentRankService`. Load that exact date's static-filtered daily metrics, build rows using the daily close fallback and daily persisted facts, and save them at a deterministic timestamp of `15:50:00 Asia/Seoul` for that trade date. Do not use the current realtime cache for a historical date. Return `success: false` without writes when the date has no reconstructable metrics.

- [ ] **Step 4: Implement bounded theme backfill**

Validate `days` as an integer from 1 through 365. Enumerate daily metric trade dates descending. For each date, call `rebuildClosingSnapshot` first and call `buildDailySnapshot` only after success. Collect per-date skips without persisting partial theme data.

- [ ] **Step 5: Expose the existing admin snapshot route through the new service**

Keep the public URL and admin guard stable. Route manual daily rebuild and backfill calls to `ThemeSnapshotService`; do not retain the legacy SQL backfill that reads daily metrics directly.

- [ ] **Step 6: Update API documentation**

Document that theme ranks/counts are based on one finalized stock snapshot and that RS80 is a response filter. Do not change response schemas.

- [ ] **Step 7: Run focused tests**

Run:

```bash
pnpm test -- current-rank.service.spec.ts data-scheduler.service.spec.ts theme-snapshot.service.spec.ts issue-theme.list.spec.ts issue-theme.detail.spec.ts issue-theme.controller.spec.ts watchlist.service.spec.ts --runInBand
```

Expected: all selected suites pass with zero failures.

- [ ] **Step 8: Run build and integrity checks**

Run:

```bash
pnpm build
git diff --check
pnpm exec prisma validate
```

Expected: all commands exit 0. If repository-wide lint still reports the existing formatting baseline, report it separately and do not auto-format unrelated files.

- [ ] **Step 9: Commit**

```bash
git add src/features/real-time-chart/current-rank.service.ts src/features/real-time-chart/current-rank.service.spec.ts src/features/issue-theme/issue-theme.controller.ts src/features/issue-theme/issue-theme.controller.spec.ts src/features/issue-theme/theme-snapshot.service.ts src/features/issue-theme/theme-snapshot.service.spec.ts docs/API_SPEC.md
git commit -m "feat: backfill themes from stock snapshots"
```

- [ ] **Step 10: Final evidence review**

Run `git log --oneline --decorate -10`, `git status --short`, and inspect the complete branch diff. Confirm unrelated untracked documents remain untouched and report any environment-only verification that could not run without database/IP access.
