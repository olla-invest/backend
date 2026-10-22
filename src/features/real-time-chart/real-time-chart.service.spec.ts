import { RealTimeChartService } from './real-time-chart.service';
import { CurrentPriceResolver } from './current-price-resolver.service';

describe('RealTimeChartService stock list RS ordering', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('ranks higher RS scores first and uses current rank then stock code for ties', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-05T01:20:01.000Z'));
    const metricsService = {
      getLatestMetrics: jest.fn().mockResolvedValue(new Map([
        ['LOW', {
          relativeStrengthScore: 91,
          currentRank: 1,
          rank: 1,
          passedStaticFilters: true,
          closePrice: 100,
        }],
        ['TIE-B', {
          relativeStrengthScore: 97,
          currentRank: 3,
          rank: 3,
          passedStaticFilters: true,
          closePrice: 100,
        }],
        ['TIE-A', {
          relativeStrengthScore: 97,
          currentRank: 2,
          rank: 2,
          passedStaticFilters: true,
          closePrice: 100,
        }],
      ])),
      getLatestTradeDate: jest.fn().mockResolvedValue(new Date('2026-08-03T00:00:00.000Z')),
      getCurrentRankTotals: jest.fn().mockResolvedValue([]),
      getCurrentRankHistory: jest.fn().mockResolvedValue(new Map()),
    };
    const chartStorage = {};
    const currentPriceService = {
      getCurrentPrices: jest.fn().mockResolvedValue(new Map([
        ['LOW', { stockCode: 'LOW', source: 'DAY_CANDLE', currentPrice: 100, changeAmount: 1, changeRate: 1 }],
      ])),
    };
    const service = new RealTimeChartService(
      {} as any,
      {} as any,
      chartStorage as any,
      metricsService as any,
      {} as any,
      new CurrentPriceResolver(),
      currentPriceService as any,
      { ensureSubscribed: jest.fn().mockResolvedValue(undefined) } as any,
      {} as any,
      {} as any,
    ) as any;
    service.fetchStockList = jest.fn().mockResolvedValue([
      { code: 'LOW', name: '낮은 점수', marketCode: '0' },
      { code: 'TIE-B', name: '동점 후순위', marketCode: '0' },
      { code: 'TIE-A', name: '동점 선순위', marketCode: '0' },
    ]);
    service.getThemeFilteredStockCodes = jest.fn().mockResolvedValue(undefined);
    service.getNaverThemesByStockCodes = jest.fn().mockResolvedValue(new Map());
    service.getNaverThemeList = jest.fn().mockResolvedValue([]);
    service.autoSubscribeStocks = jest.fn().mockResolvedValue(undefined);

    const result = await service.getStockList('all', 1, 10);

    expect(result.stocks.map((stock: any) => ({
      stockCode: stock.stockCode,
      rank: stock.rank,
      relativeStrengthScore: stock.relativeStrengthScore,
    }))).toEqual([
      { stockCode: 'TIE-A', rank: 1, relativeStrengthScore: 97 },
      { stockCode: 'TIE-B', rank: 2, relativeStrengthScore: 97 },
      { stockCode: 'LOW', rank: 3, relativeStrengthScore: 91 },
    ]);
    expect(result.stocks.find((stock: any) => stock.stockCode === 'LOW')).toMatchObject({ currentPrice: 100, priceSource: 'DAY_CANDLE' });
    expect(currentPriceService.getCurrentPrices).toHaveBeenCalledWith(['LOW', 'TIE-B', 'TIE-A']);
  });
});

describe('secondary environment startup', () => {
  it('skips candle backfill but prepares realtime subscriptions when batches are disabled', async () => {
    const service = new RealTimeChartService({} as any, {} as any, {} as any, {} as any, {} as any, new CurrentPriceResolver(), {} as any, {} as any, {} as any, {} as any, {get: (key: string, fallback: string) => key === 'SCHEDULER_ENABLED' ? 'false' : fallback} as any);
    const initialize = jest.spyOn(service, 'initializeData').mockResolvedValue({} as any);
    const subscribe = jest.spyOn(service, 'subscribeFilteredStocks').mockResolvedValue(undefined);
    await service.onModuleInit();
    expect(initialize).not.toHaveBeenCalled(); expect(subscribe).toHaveBeenCalled();
  });
});

describe('empty broker candle responses', () => {
  it('ignores empty placeholder rows without saving invalid dates or prices', async () => {
    const placeholder = {dt: '', cur_prc: '', trde_qty: '', open_pric: '', high_pric: '', low_pric: ''};
    const broker = {getDayCandlesWithHistory: jest.fn().mockResolvedValue({stk_dt_pole_chart_qry: [placeholder]})};
    const storage = {saveCandle: jest.fn().mockResolvedValue(undefined)};
    const service = new RealTimeChartService(broker as any, {} as any, storage as any, {} as any, {} as any, new CurrentPriceResolver(), {} as any, {} as any, {} as any, {} as any) as any;
    expect(await service.collectStockDayCandlesWithAdjusted('084180', '20261006', 10)).toEqual({saved: 0, adjustmentEventDates: []});
    expect(storage.saveCandle).not.toHaveBeenCalled();
  });
});

describe('adjusted-price history refetch', () => {
  it('refetches stored history only for stocks Kiwoom flags with a non-zero adjustment ratio', async () => {
    const row = (dt: string, extra = {}) => ({dt, cur_prc: '1000', trde_qty: '1', open_pric: '1000', high_pric: '1000', low_pric: '1000', ...extra});
    const rows: Record<string, unknown[]> = {
      '000010': [row('20261006'), row('20260929', {upd_rt: '+21.87'})],
      '000020': [row('20261006'), row('20251229', {upd_stkpc_tp: '4', upd_rt: '0.00'})],
      '000030': [row('20261006')],
    };
    const broker = {
      getStockList: jest.fn().mockResolvedValue({list: Object.keys(rows).map((code) => ({code, marketCode: '0'}))}),
      getDayCandlesWithHistory: jest.fn((...args: any[]) => Promise.resolve({stk_dt_pole_chart_qry: rows[args[0]]})),
    };
    const storage = {saveCandle: jest.fn().mockResolvedValue(undefined)};
    const service = new RealTimeChartService(broker as any, {} as any, storage as any, {} as any, {} as any, new CurrentPriceResolver(), {} as any, {} as any, {} as any, {} as any);

    const result = await service.collectAllDayCandles('0', 10);

    const historyCalls = broker.getDayCandlesWithHistory.mock.calls.filter((args) => args[2] === 750);
    expect(historyCalls.map((args) => `${args[0]}:${args[3]}`)).toEqual(['000010:0', '000010:1']);
    expect(result.adjustmentRefetch).toEqual([{code: '000010', count: 2, status: 'ok'}]);
    expect(result.success).toBe(3);
  });
});

describe('realtime day candle persistence', () => {
  afterEach(() => jest.useRealTimers());
  it('does not let after-hours ticks overwrite the regular-session close', async () => {
    const storage = {saveCandle: jest.fn().mockResolvedValue(undefined)};
    const service = new RealTimeChartService({} as any, {} as any, storage as any, {} as any, {} as any, new CurrentPriceResolver(), {} as any, {} as any, {} as any, {} as any) as any;
    service.upsertRealtimeCandles = jest.fn().mockResolvedValue(undefined);
    const tick = {stockCode: '036930', type: '0B', values: {'10': '283000'}};
    jest.useFakeTimers().setSystemTime(new Date('2026-10-06T07:30:00Z')); // 16:30 KST
    await service.handleRealtimeCandlePersistence(tick);
    expect(service.upsertRealtimeCandles).not.toHaveBeenCalled();
    jest.setSystemTime(new Date('2026-10-06T06:29:00Z')); // 15:29 KST
    await service.handleRealtimeCandlePersistence(tick);
    expect(service.upsertRealtimeCandles).toHaveBeenCalledTimes(1);
  });

  it('skips realtime candle writes when REALTIME_CANDLE_PERSIST=false', async () => {
    const config = { get: (key: string, fallback?: string) => (key === 'REALTIME_CANDLE_PERSIST' ? 'false' : fallback) };
    const service = new RealTimeChartService({} as any, {} as any, {} as any, {} as any, {} as any, new CurrentPriceResolver(), {} as any, {} as any, {} as any, {} as any, config as any) as any;
    service.upsertRealtimeCandles = jest.fn().mockResolvedValue(undefined);
    jest.useFakeTimers().setSystemTime(new Date('2026-10-06T01:00:00Z')); // 10:00 KST

    await service.handleRealtimeCandlePersistence({stockCode: '036930', type: '0B', values: {'10': '283000'}});

    expect(service.upsertRealtimeCandles).not.toHaveBeenCalled();
  });
});

describe('rank history window', () => {
  afterEach(() => jest.useRealTimers());

  // 10/6 is the latest aggregated day. D-1 must be 10/6 both during 10/7's session and after it,
  // until the 10/7 aggregation lands (formerly mornings skipped back to 10/2).
  it.each([
    ['10:00 KST during the session', '2026-10-07T01:00:00Z'],
    ['21:00 KST after the close', '2026-10-07T12:00:00Z'],
  ])('includes the latest aggregated day at %s', async (_label, now) => {
    jest.useFakeTimers().setSystemTime(new Date(now));
    const latestTradeDate = new Date('2026-10-06T00:00:00.000Z');
    const metricsService = {
      getLatestMetrics: jest.fn().mockResolvedValue(new Map([
        ['000001', { relativeStrengthScore: 90, currentRank: 1, rank: 1, passedStaticFilters: true, closePrice: 100 }],
      ])),
      getLatestTradeDate: jest.fn().mockResolvedValue(latestTradeDate),
      getCurrentRankTotals: jest.fn().mockResolvedValue([]),
      getCurrentRankHistory: jest.fn().mockResolvedValue(new Map()),
    };
    const service = new RealTimeChartService(
      {} as any,
      {} as any,
      {} as any,
      metricsService as any,
      {} as any,
      new CurrentPriceResolver(),
      { getCurrentPrices: jest.fn().mockResolvedValue(new Map()) } as any,
      { ensureSubscribed: jest.fn().mockResolvedValue(undefined) } as any,
      {} as any,
      {} as any,
    ) as any;
    service.fetchStockList = jest.fn().mockResolvedValue([{ code: '000001', name: '종목', marketCode: '0' }]);
    service.getThemeFilteredStockCodes = jest.fn().mockResolvedValue(undefined);
    service.getNaverThemesByStockCodes = jest.fn().mockResolvedValue(new Map());
    service.getNaverThemeList = jest.fn().mockResolvedValue([]);

    await service.getStockList('all', 1, 10);

    expect(metricsService.getCurrentRankHistory).toHaveBeenCalledWith(['000001'], 3, latestTradeDate, true);
    expect(metricsService.getCurrentRankTotals).toHaveBeenCalledWith(3, latestTradeDate, true);
  });
});

describe('RealTimeChartService new-high flag', () => {
  const isAtNewHigh = (RealTimeChartService.prototype as any).isAtNewHigh;

  it('drops the previous day new-high flag once the current price is below the 52-week high', () => {
    expect(isAtNewHigh(31_000, { highPrice52w: 32_000, isNewHigh: true })).toBe(false);
  });

  it('flags a new high when the current price reaches the 52-week high', () => {
    expect(isAtNewHigh(32_500, { highPrice52w: 32_000, isNewHigh: false })).toBe(true);
  });

  it('falls back to the stored flag without a 52-week high or price', () => {
    expect(isAtNewHigh(0, { highPrice52w: 32_000, isNewHigh: true })).toBe(true);
    expect(isAtNewHigh(31_000, { highPrice52w: null, isNewHigh: true })).toBe(true);
    expect(isAtNewHigh(31_000, undefined)).toBe(false);
  });
});

describe('realtime status price freshness', () => {
  afterEach(() => jest.useRealTimers());

  it('reports subscribed stocks that have no tick for the price date', () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-15T04:00:00.000Z'));
    const todayTick = {
      stockCode: 'A', currentPrice: 100, changeAmount: 1, changeRate: 1, volume: 1, accVolume: 1, accAmount: 1,
      openPrice: 99, highPrice: 101, lowPrice: 98, timestamp: new Date('2026-10-15T01:00:00.000Z'),
    };
    const yesterdayTick = { ...todayTick, stockCode: 'B', timestamp: new Date('2026-10-14T06:00:00.000Z') };
    const realtimeCache = {
      getCacheStats: () => ({}),
      getSubscribedStocks: () => ['A', 'B'],
      getAllPrices: () => new Map([['A', todayTick], ['B', yesterdayTick]]),
    };
    const service = new RealTimeChartService(
      {} as any,
      { isConnected: () => true } as any,
      {} as any,
      {} as any,
      realtimeCache as any,
      new CurrentPriceResolver(),
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );

    expect(service.getRealtimeStatus().prices).toEqual({
      priceDate: '2026-10-15',
      priceDateStocks: 1,
      subscribedWithoutPrice: 1,
      subscribedWithoutPriceSample: ['B'],
    });
  });
});

describe('company name sync from the Kiwoom stock list', () => {
  const build = (companies: Array<{ stockCode: string; companyName: string }>, overrides: { kiwoomRest?: any; stockListCache?: any } = {}) => {
    const prisma = {
      company: {
        findMany: jest.fn().mockResolvedValue(companies),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const service = new RealTimeChartService(
      overrides.kiwoomRest ?? ({} as any),
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      new CurrentPriceResolver(),
      {} as any,
      {} as any,
      overrides.stockListCache ?? ({} as any),
      prisma as any,
    ) as any;
    return { service, prisma };
  };

  it('renames only the stocks whose Kiwoom name changed', async () => {
    const { service, prisma } = build([
      { stockCode: '396300', companyName: '세아메카닉스' },
      { stockCode: '005930', companyName: '삼성전자' },
    ]);

    const renamed = await service.syncCompanyNames([
      { code: '396300', name: 'HT로보틱스 ' },
      { code: '005930', name: '삼성전자' },
      { code: '000001', name: '' },
      { code: '000002', name: 'x'.repeat(101) },
    ]);

    expect(renamed).toBe(1);
    expect(prisma.company.findMany.mock.calls[0][0].where.stockCode.in).toEqual(['396300', '005930']);
    expect(prisma.company.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.company.updateMany).toHaveBeenCalledWith({
      where: { stockCode: '396300', companyName: '세아메카닉스', deletedAt: null },
      data: { companyName: 'HT로보틱스' },
    });
  });

  it('compares names whenever a fresh list is fetched from Kiwoom', async () => {
    const kiwoomRest = {
      getStockList: jest.fn()
        .mockResolvedValueOnce({ list: [{ code: '396300', name: 'HT로보틱스', state: '' }] })
        .mockResolvedValueOnce({ list: [{ code: '091810', name: '트리니티항공', state: '' }] }),
    };
    const stockListCache = { getStockList: jest.fn().mockResolvedValue(null), setStockList: jest.fn() };
    const { service, prisma } = build([{ stockCode: '396300', companyName: '세아메카닉스' }], { kiwoomRest, stockListCache });

    await service.fetchStockList('all');
    await service.companyNameSync;

    expect(prisma.company.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { companyName: 'HT로보틱스' } }));
  });
});

describe('stored candles follow the shared current price', () => {
  afterEach(() => jest.useRealTimers());

  const dayCandle = (date: string, open: number, close: number, volume: bigint) => ({
    candleTime: new Date(`${date}T00:00:00.000Z`),
    openPrice: open, highPrice: Math.max(open, close), lowPrice: Math.min(open, close), closePrice: close,
    volume, tradingValue: volume * BigInt(close),
  });
  const makeService = (price: Record<string, unknown> | undefined) => {
    const chartStorage = {
      getCandles: jest.fn().mockResolvedValue([
        dayCandle('2026-10-22', 10540, 10860, 7459215n),
        dayCandle('2026-10-21', 8050, 10450, 2498150n),
      ]),
    };
    const prisma = { stockCandle: { findFirst: jest.fn().mockResolvedValue(dayCandle('2026-10-20', 8000, 8140, 1000n)) } };
    const currentPriceService = { getCurrentPrice: jest.fn().mockResolvedValue(price) };
    const realtimeCache = { getPrice: jest.fn() };
    const service = new RealTimeChartService(
      {} as any,
      {} as any,
      chartStorage as any,
      {} as any,
      realtimeCache as any,
      new CurrentPriceResolver(),
      currentPriceService as any,
      { ensureSubscribed: jest.fn().mockResolvedValue(undefined) } as any,
      {} as any,
      prisma as any,
    );
    return { service, realtimeCache, currentPriceService };
  };
  const closePrice = (overrides: Record<string, unknown>) => ({
    stockCode: '003010', priceDate: '2026-10-22', source: 'DAY_CANDLE', currentPrice: 10860,
    changeAmount: 410, changeRate: 3.923444976, changeSign: '2', openPrice: 10540, highPrice: 12660, lowPrice: 10510,
    accVolume: 7459215n, tradingValue: 87752000000n, ...overrides,
  });

  it('shows the same close as the summary instead of a tick that missed the closing print', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-22T14:00:00.000Z'));
    const { service, realtimeCache, currentPriceService } = makeService(closePrice({}));

    const result = await service.getStoredCandles('003010', 'day');

    expect(result.candles[0]).toMatchObject({ time: '2026-10-22T00:00:00.000Z', close: '10860', volume: '7459215', changeRate: '3.92%' });
    expect(currentPriceService.getCurrentPrice).toHaveBeenCalledWith('003010', { fetchMissing: true });
    expect(realtimeCache.getPrice).not.toHaveBeenCalled();
  });

  it('fills the price date candle before the open instead of adding a row for the calendar day', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-22T23:00:00.000Z'));
    const { service } = makeService(closePrice({}));

    const result = await service.getStoredCandles('003010', 'day');

    expect(result.candles.map((c: any) => c.time.slice(0, 10))).toEqual(['2026-10-22', '2026-10-21']);
  });

  it('adds no candle when the stock has not traded on the price date', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-23T02:00:00.000Z'));
    const { service } = makeService(closePrice({
      priceDate: '2026-10-23', source: 'BASE_PRICE', changeAmount: 0, changeRate: 0, accVolume: 0n, tradingValue: 0n,
    }));

    const result = await service.getStoredCandles('003010', 'day');

    expect(result.candles.map((c: any) => c.time.slice(0, 10))).toEqual(['2026-10-22', '2026-10-21']);
  });
});
