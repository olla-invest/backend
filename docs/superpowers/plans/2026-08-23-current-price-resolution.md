# Current Price Resolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve every existing endpoint and response shape while making real-time price freshness and close-price fallback identical in real-time chart and issue-theme responses.

**Architecture:** Add one injectable `CurrentPriceResolver` beside the shared real-time cache. It owns KST market-session and ten-minute freshness checks and returns the usable real-time record or a DB-backed price snapshot. Existing services retain response assembly but delegate all real-time eligibility decisions to this resolver.

**Tech Stack:** NestJS 11, TypeScript 5.9, Jest 30

**Spec:** `docs/superpowers/specs/2026-08-23-realtime-data-pipeline-simplification-design.md`

## Global Constraints

- Do not change API URLs, HTTP methods, request parameters, response field names, response types, or nesting.
- Do not add `priceSource`, `fallbackReason`, or `observedAt` to an endpoint that does not already return such a field.
- Keep the existing ten-minute real-time freshness window and KRX session window of 09:00 through 15:30 KST.
- Keep existing DB fallback order at each call site.
- Do not change subscription management or daily-rank finalization in this plan.

---

## File Structure

- Create `src/features/real-time-chart/current-price-resolver.service.ts`: the sole real-time freshness and price-snapshot decision component.
- Create `src/features/real-time-chart/current-price-resolver.service.spec.ts`: deterministic clock-boundary and fallback tests.
- Modify `src/features/real-time-chart/realtime-price-cache.module.ts`: provide and export the resolver.
- Modify `src/features/real-time-chart/real-time-chart.service.ts`: replace private real-time eligibility checks with the resolver.
- Modify `src/features/real-time-chart/real-time-chart.service.spec.ts`: inject the resolver and preserve stock-list response behavior.
- Modify `src/features/issue-theme/issue-theme.service.ts`: replace duplicated freshness and price-snapshot logic.
- Modify `src/features/issue-theme/issue-theme.list.spec.ts`: inject the resolver and verify stale ticks use DB metrics.
- Modify `src/features/issue-theme/issue-theme.detail.spec.ts`: inject the resolver and verify fresh ticks preserve the existing detail schema.

### Task 1: Common real-time eligibility resolver

**Files:**
- Create: `src/features/real-time-chart/current-price-resolver.service.ts`
- Create: `src/features/real-time-chart/current-price-resolver.service.spec.ts`
- Modify: `src/features/real-time-chart/realtime-price-cache.module.ts`

**Interfaces:**
- Consumes: `RealtimePrice` from `realtime-price-cache.service.ts`.
- Produces: `getUsableRealtimePrice(realtimePrice: RealtimePrice | undefined, now?: Date): RealtimePrice | undefined`.
- Produces: `resolveMetricSnapshot(metric: MetricPriceFallback, realtimePrice: RealtimePrice | undefined, now?: Date): ResolvedMetricPrice`.

- [ ] **Step 1: Write the failing resolver tests**

Create tests using fixed UTC instants so they do not depend on the machine clock:

```ts
import { CurrentPriceResolver } from './current-price-resolver.service';
import { RealtimePrice } from './realtime-price-cache.service';

const tick = (overrides: Partial<RealtimePrice> = {}): RealtimePrice => ({
  stockCode: '041830', currentPrice: 31_500, changeAmount: 500, changeRate: 1.61,
  volume: 10, accVolume: 100, accAmount: 3_000_000, openPrice: 31_000,
  highPrice: 31_700, lowPrice: 30_800,
  timestamp: new Date('2026-08-05T01:00:00.000Z'),
  ...overrides,
});

describe('CurrentPriceResolver', () => {
  const resolver = new CurrentPriceResolver();

  it('accepts a same-day tick no older than ten minutes during the KRX session', () => {
    expect(resolver.getUsableRealtimePrice(tick(), new Date('2026-08-05T01:09:59.000Z'))?.currentPrice).toBe(31_500);
  });

  it('rejects a tick older than ten minutes', () => {
    expect(resolver.getUsableRealtimePrice(tick(), new Date('2026-08-05T01:10:01.000Z'))).toBeUndefined();
  });

  it('rejects a tick outside the market session', () => {
    expect(resolver.getUsableRealtimePrice(tick(), new Date('2026-08-05T06:31:00.000Z'))).toBeUndefined();
  });

  it('rejects zero and non-finite current prices', () => {
    expect(resolver.getUsableRealtimePrice(tick({ currentPrice: 0 }), new Date('2026-08-05T01:05:00.000Z'))).toBeUndefined();
    expect(resolver.getUsableRealtimePrice(tick({ currentPrice: Number.NaN }), new Date('2026-08-05T01:05:00.000Z'))).toBeUndefined();
  });

  it('uses metric close and daily changes when the tick is stale', () => {
    expect(resolver.resolveMetricSnapshot(
      { closePrice: 30_800, priceChange1d: -200, priceChangeRate1d: -0.65 },
      tick(),
      new Date('2026-08-05T01:10:01.000Z'),
    )).toEqual({
      currentPrice: 30_800, closePrice: 30_800, changeRate: -0.65,
      priceChange1d: -200, priceChangeRate1d: -0.65, usedRealtime: false,
    });
  });
});
```

- [ ] **Step 2: Run the resolver test and verify RED**

Run: `npx jest src/features/real-time-chart/current-price-resolver.service.spec.ts --runInBand`

Expected: FAIL because `current-price-resolver.service.ts` does not exist.

- [ ] **Step 3: Implement the minimal resolver**

Implement these exported interfaces and methods:

```ts
export interface MetricPriceFallback {
  closePrice: unknown;
  priceChange1d?: unknown;
  priceChangeRate1d?: unknown;
}

export interface ResolvedMetricPrice {
  currentPrice: number;
  closePrice: number;
  changeRate: number;
  priceChange1d: number | null;
  priceChangeRate1d: number | null;
  usedRealtime: boolean;
}

@Injectable()
export class CurrentPriceResolver {
  private static readonly MAX_REALTIME_AGE_MS = 10 * 60 * 1000;

  getUsableRealtimePrice(realtimePrice: RealtimePrice | undefined, now = new Date()): RealtimePrice | undefined {
    // Validate currentPrice, KRX session, KST date, timestamp, and ten-minute age.
  }

  resolveMetricSnapshot(metric: MetricPriceFallback, realtimePrice?: RealtimePrice, now = new Date()): ResolvedMetricPrice {
    // Use usable tick current/open prices; otherwise preserve metric close/change fallbacks.
  }
}
```

For a usable tick, calculate issue-theme change values from open to current exactly as the existing service does. If the tick has no positive open price, use metric daily change fields. Set `usedRealtime` from the usable-tick result, not merely from the presence of a cache entry.

Register and export `CurrentPriceResolver` in `RealtimePriceCacheModule`.

- [ ] **Step 4: Run the resolver test and verify GREEN**

Run: `npx jest src/features/real-time-chart/current-price-resolver.service.spec.ts --runInBand`

Expected: PASS, 5 tests.

- [ ] **Step 5: Commit the resolver task**

```bash
git add src/features/real-time-chart/current-price-resolver.service.ts src/features/real-time-chart/current-price-resolver.service.spec.ts src/features/real-time-chart/realtime-price-cache.module.ts
git commit -m "refactor: centralize realtime price resolution"
```

### Task 2: Real-time chart integration

**Files:**
- Modify: `src/features/real-time-chart/real-time-chart.service.ts`
- Modify: `src/features/real-time-chart/real-time-chart.service.spec.ts`

**Interfaces:**
- Consumes: `CurrentPriceResolver.getUsableRealtimePrice(...)` from Task 1.
- Produces: unchanged real-time chart endpoint response objects.

- [ ] **Step 1: Write a failing stock-list integration test**

Extend the existing stock-list spec with a resolver argument and a stale tick. Fix the system time at an active KRX session and assert that the returned `currentPrice` remains the metric close:

```ts
jest.useFakeTimers().setSystemTime(new Date('2026-08-05T01:20:01.000Z'));
const realtimeCache = {
  getPrices: jest.fn().mockReturnValue(new Map([['LOW', {
    stockCode: 'LOW', currentPrice: 999, openPrice: 900,
    timestamp: new Date('2026-08-05T01:00:00.000Z'),
  }]])),
};

expect(result.stocks.find((stock: any) => stock.stockCode === 'LOW').currentPrice).toBe(100);
```

Restore real timers in `afterEach`.

- [ ] **Step 2: Run the chart spec and verify RED**

Run: `npx jest src/features/real-time-chart/real-time-chart.service.spec.ts --runInBand`

Expected: FAIL after changing the constructor expectation because `RealTimeChartService` does not yet consume `CurrentPriceResolver`.

- [ ] **Step 3: Replace chart-local eligibility checks**

Inject `CurrentPriceResolver` immediately after `RealtimePriceCacheService` in the constructor. Replace every call to private `getUsableRealtimePrice` with `this.currentPriceResolver.getUsableRealtimePrice(...)`, then delete the private method. Preserve all existing DB fallback expressions and response fields.

Update direct constructor calls in specs by passing `new CurrentPriceResolver()` in the matching position.

- [ ] **Step 4: Run focused chart tests**

Run: `npx jest src/features/real-time-chart/real-time-chart.service.spec.ts src/features/real-time-chart/rank-change.util.spec.ts --runInBand`

Expected: PASS.

- [ ] **Step 5: Commit chart integration**

```bash
git add src/features/real-time-chart/real-time-chart.service.ts src/features/real-time-chart/real-time-chart.service.spec.ts
git commit -m "refactor: use common price resolver in realtime chart"
```

### Task 3: Issue-theme integration

**Files:**
- Modify: `src/features/issue-theme/issue-theme.service.ts`
- Modify: `src/features/issue-theme/issue-theme.list.spec.ts`
- Modify: `src/features/issue-theme/issue-theme.detail.spec.ts`

**Interfaces:**
- Consumes: `CurrentPriceResolver.getUsableRealtimePrice(...)` and `resolveMetricSnapshot(...)` from Task 1.
- Produces: unchanged issue-theme list and detail response objects, including the existing `priceSource` field in detail rows.

- [ ] **Step 1: Write failing stale/fresh issue-theme tests**

Add one list test with a stale cached tick and metric `priceChangeRate1d: 4`; assert the theme change rate uses `4`, not the cached tick. Add one detail test with a fresh tick at a fixed KRX-session time and assert the existing response fields remain:

```ts
expect(result?.stocks[0]).toMatchObject({
  currentPrice: 31_500,
  closePrice: 31_500,
  priceSource: 'REALTIME_CACHE',
});
```

The stale case must expect the existing `DB` source and metric close. Restore real timers after each test.

- [ ] **Step 2: Run issue-theme tests and verify RED**

Run: `npx jest src/features/issue-theme/issue-theme.list.spec.ts src/features/issue-theme/issue-theme.detail.spec.ts --runInBand`

Expected: FAIL because the service constructor and duplicated helper methods have not been replaced.

- [ ] **Step 3: Replace issue-theme-local price logic**

Inject `CurrentPriceResolver` after `RealtimePriceCacheService`. Replace `getActiveRealtimePrice` calls with the resolver. Replace `getStockPriceSnapshot` with `resolveMetricSnapshot`, mapping `usedRealtime` back to the existing detail-only strings:

```ts
priceSource: resolved.usedRealtime ? 'REALTIME_CACHE' : 'DB'
```

Delete `getKstDateKey`, `getActiveRealtimePrice`, `getStockPriceSnapshot`, and `getOpenToCurrentChangeRate`. Retain `getKstNow`, `getCurrentSnapshotTime`, and `isMarketOpenNow` because trading-value snapshots still use them.

Update every direct `new IssueThemeService(...)` test construction with `new CurrentPriceResolver()`.

- [ ] **Step 4: Run issue-theme tests and verify GREEN**

Run: `npx jest src/features/issue-theme/issue-theme.list.spec.ts src/features/issue-theme/issue-theme.detail.spec.ts src/features/issue-theme/issue-theme.controller.spec.ts src/features/issue-theme/theme-metrics.service.spec.ts --runInBand`

Expected: PASS.

- [ ] **Step 5: Commit issue-theme integration**

```bash
git add src/features/issue-theme/issue-theme.service.ts src/features/issue-theme/issue-theme.list.spec.ts src/features/issue-theme/issue-theme.detail.spec.ts
git commit -m "refactor: use common price resolver in issue themes"
```

### Task 4: Contract and build verification

**Files:**
- Modify: only files already named above if verification reveals a compatibility regression.

**Interfaces:**
- Consumes: completed Tasks 1-3.
- Produces: verified unchanged public API contract and compilable NestJS application.

- [ ] **Step 1: Run all feature tests**

Run: `npx jest src/features/real-time-chart src/features/issue-theme --runInBand`

Expected: PASS with no failed suites.

- [ ] **Step 2: Run the full test suite**

Run: `npm test -- --runInBand`

Expected: PASS with no failed suites.

- [ ] **Step 3: Build the application**

Run: `npm run build`

Expected: exit code 0 with no TypeScript errors.

- [ ] **Step 4: Verify public controllers and Swagger are unchanged**

Run:

```bash
git diff b2fe7c4 -- src/features/real-time-chart/real-time-chart.controller.ts src/features/issue-theme/issue-theme.controller.ts swagger.json
```

Expected: no output.

- [ ] **Step 5: Review final diff for accidental scope expansion**

Run: `git diff b2fe7c4 --stat && git status --short`

Expected: changes are limited to the spec, plan, resolver, module wiring, the two consuming services, and their tests.
