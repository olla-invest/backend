import { CurrentPrice } from './current-price.service';
import { CurrentRankService } from './current-rank.service';

const metricRow = (overrides: Record<string, unknown> = {}) => ({
  stock_code: '041830', trade_date: new Date('2026-08-04'), close_price: '30800',
  relative_strength_score: '90', rank: 1, high_price_52w: '35000',
  low_price_52w: '20000', ma_50: '25000', price_change_rate_1d: '2.5',
  price_change_1d: '750', trading_value: 12_000n, is_new_high: false,
  short_term_rs: '88.67',
  ...overrides,
});

const currentPrice = (overrides: Partial<CurrentPrice> = {}): CurrentPrice => ({
  stockCode: '041830',
  priceDate: '2026-08-05',
  source: 'REALTIME',
  currentPrice: 31_500,
  changeAmount: 700,
  changeRate: 2.27,
  changeSign: '2',
  openPrice: 31_000,
  highPrice: 31_700,
  lowPrice: 30_800,
  accVolume: 1n,
  tradingValue: 24_000n,
  ...overrides,
});

describe('CurrentRankService price selection', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('uses the same-day day candle instead of the previous-day metric close', () => {
    const service = new CurrentRankService({} as any, {} as any) as any;

    const rows = service.buildRankRows(
      [metricRow()],
      new Date('2026-08-05'),
      new Date('2026-08-05T01:20:00.000Z'),
      new Map([['041830', 4_800n]]),
      new Map([['041830', currentPrice({
        source: 'DAY_CANDLE', currentPrice: 31_200, changeAmount: 400, changeRate: 1.3, tradingValue: 12_000n,
      })]]),
    );

    expect(rows[0]).toMatchObject({
      currentPrice: 31_200,
      closePrice: 30_800,
      priceSource: 'day_candle',
      priceChangeRate: 1.3,
      priceChange1d: 400,
      tradingValue: 12_000n,
      previousTradingValueRatio: 2.5,
      isNewHigh: false,
      shortTermRs: 88.67,
    });
  });

  it('falls back to the metric of the same date only when no current price is given', () => {
    const service = new CurrentRankService({} as any, {} as any) as any;

    const rows = service.buildRankRows([metricRow()], new Date('2026-08-04'), new Date('2026-08-04T06:50:00.000Z'));

    expect(rows[0]).toMatchObject({
      currentPrice: 30_800,
      priceSource: 'close',
      priceChangeRate: 2.5,
      priceChange1d: 750,
      tradingValue: 12_000n,
    });
  });

  it('asks for prices of the snapshot trade date, not the previous-day metric date', async () => {
    const getCurrentPrices = jest.fn().mockResolvedValue(new Map([['041830', currentPrice({ priceDate: '2026-10-15' })]]));
    const service = new CurrentRankService({} as any, { getCurrentPrices } as any) as any;
    jest.spyOn(service, 'getLatestMetricTradeDate').mockResolvedValue(new Date('2026-10-14'));
    jest.spyOn(service, 'getStaticFilteredMetrics').mockResolvedValue([metricRow({ trade_date: new Date('2026-10-14') })]);
    jest.spyOn(service, 'getPreviousTradingValues').mockResolvedValue(new Map());
    const save = jest.spyOn(service, 'saveSnapshotRows').mockResolvedValue(undefined);

    await service.createCurrentRankSnapshot(new Date('2026-10-15T01:20:00.000Z'), new Date('2026-10-15'));

    expect(getCurrentPrices).toHaveBeenCalledWith(['041830'], { priceDate: '2026-10-15' });
    expect(save.mock.calls[0][0][0]).toMatchObject({ currentPrice: 31_500, priceSource: 'realtime', tradeDate: '2026-10-15' });
  });

  it('persists every theme aggregation fact in the stock snapshot row', async () => {
    const prisma = { $executeRawUnsafe: jest.fn().mockResolvedValue(1) };
    const service = new CurrentRankService(
      prisma as any,
      {} as any,
    ) as any;

    await service.saveSnapshotRows([{
      stockCode: '041830',
      tradeDate: '2026-08-05',
      snapshotTime: '2026-08-05T06:50:00.000Z',
      currentRank: 1,
      relativeStrengthScore: 90,
      currentPrice: 30_800,
      closePrice: 30_800,
      highPrice52w: 35_000,
      lowPrice52w: 20_000,
      ma50: 25_000,
      passedDynamicFilters: true,
      priceSource: 'close',
      priceChangeRate: 2.5,
      priceChange1d: 750,
      tradingValue: 12_000n,
      previousTradingValueRatio: 2.5,
      isNewHigh: false,
      shortTermRs: 88.67,
    }]);

    const [sql, ...params] = prisma.$executeRawUnsafe.mock.calls[0];
    expect(sql).toContain('price_change_rate');
    expect(sql).toContain('previous_trading_value_ratio');
    expect(sql).toContain('short_term_rs');
    expect(sql).toContain('price_change_1d');
    expect(params).toEqual(expect.arrayContaining([2.5, 750, 12_000n, false]));
  });

  it('uses the current price change amount and KRW trading value', () => {
    const service = new CurrentRankService({} as any, {} as any) as any;

    const rows = service.buildRankRows(
      [metricRow({ stock_code: '033780', trading_value: 65_895_000_000n })],
      new Date('2026-10-15'),
      new Date('2026-10-15T00:10:00.000Z'),
      new Map([['033780', 141_000_000n]]),
      new Map([['033780', currentPrice({ stockCode: '033780', tradingValue: 5_684_000_000n })]]),
    );

    expect(rows[0]).toMatchObject({ priceSource: 'realtime', priceChangeRate: 2.27, priceChange1d: 700 });
    expect(rows[0].tradingValue).toBe(5_684_000_000n);
    expect(rows[0].previousTradingValueRatio).toBeCloseTo(40.31, 2);
  });

  it('drops a trading value ratio that would overflow the snapshot column', () => {
    const service = new CurrentRankService(
      {} as any,
      {} as any,
    ) as any;

    const rows = service.buildRankRows([
      {
        stock_code: '001820', trade_date: new Date('2026-10-14'), close_price: '30800',
        relative_strength_score: '90', rank: 1, high_price_52w: '35000',
        low_price_52w: '20000', ma_50: '25000', price_change_rate_1d: '2.5',
        price_change_1d: '750', trading_value: 65_895_000_000n, is_new_high: false,
        short_term_rs: '88.67',
      },
    ], new Date('2026-10-15'), new Date('2026-10-15T00:00:00.000Z'), new Map([
      ['001820', 2n],
    ]));

    expect(rows[0].previousTradingValueRatio).toBeNull();
  });

  it('normalizes legacy million-KRW previous trading values read from snapshots', async () => {
    const prisma = {
      $queryRawUnsafe: jest.fn().mockResolvedValue([
        { stock_code: '033780', trading_value: 141n },
        { stock_code: '001820', trading_value: 65_895_000_000n },
      ]),
    };
    const service = new CurrentRankService(
      prisma as any,
      {} as any,
    ) as any;

    const values = await service.getPreviousTradingValues(
      new Date('2026-10-15'),
      new Date('2026-10-15T00:00:00.000Z'),
    );

    expect(values.get('033780')).toBe(141_000_000n);
    expect(values.get('001820')).toBe(65_895_000_000n);
  });

  it('compares trading value against the previous day at the same time of day', async () => {
    const prisma = { $queryRawUnsafe: jest.fn().mockResolvedValue([]) };
    const service = new CurrentRankService(
      prisma as any,
      {} as any,
    ) as any;

    await service.getPreviousTradingValues(
      new Date('2026-08-10'),
      new Date('2026-08-10T01:20:00.000Z'),
    );

    const [sql, ...params] = prisma.$queryRawUnsafe.mock.calls[0];
    expect(sql).toContain('snapshot_time::time');
    expect(params).toEqual(['2026-08-10', '01:20:00']);
  });

  it('finalizes daily ranks from the last snapshot at or before the 15:40 KST close', async () => {
    const prisma = {
      $queryRawUnsafe: jest.fn()
        .mockResolvedValueOnce([{ snapshot_time: new Date('2026-10-15T06:30:00.000Z') }])
        .mockResolvedValueOnce([{ updated: 33 }]),
    };
    const service = new CurrentRankService(
      prisma as any,
      {} as any,
    ) as any;

    const result = await service.finalizeDailyCurrentRank(new Date('2026-10-15'));

    const [lookupSql, ...lookupParams] = prisma.$queryRawUnsafe.mock.calls[0];
    expect(lookupSql).toContain('snapshot_time <= $2::timestamp');
    expect(lookupParams).toEqual(['2026-10-15', '2026-10-15T06:40:00.000Z']);
    expect(prisma.$queryRawUnsafe.mock.calls[1].slice(1)).toEqual(['2026-10-15', '2026-10-15T06:30:00.000Z']);
    expect(result).toMatchObject({ success: true, updated: 33, snapshotTime: '2026-10-15T06:30:00.000Z' });
  });

  it('skips finalization instead of ranking with same-day metrics when no closing snapshot exists', async () => {
    const prisma = { $queryRawUnsafe: jest.fn().mockResolvedValueOnce([]) };
    const service = new CurrentRankService(
      prisma as any,
      {} as any,
    ) as any;
    const create = jest.spyOn(service, 'createCurrentRankSnapshot');

    const result = await service.finalizeDailyCurrentRank(new Date('2026-10-15'));

    expect(result).toMatchObject({ success: false, updated: 0 });
    expect(prisma.$queryRawUnsafe).toHaveBeenCalledTimes(1);
    expect(create).not.toHaveBeenCalled();
  });

  it('pins the closing snapshot to 15:40 KST while metrics are still from the previous day', async () => {
    const service = new CurrentRankService({} as any, {} as any) as any;
    jest.spyOn(service, 'getLatestMetricTradeDate').mockResolvedValue(new Date('2026-10-14'));
    const create = jest.spyOn(service, 'createCurrentRankSnapshot').mockResolvedValue({ success: true });

    await service.createClosingSnapshot(new Date('2026-10-15'));

    expect(create).toHaveBeenCalledWith(new Date('2026-10-15T06:40:00.000Z'), new Date('2026-10-15T00:00:00.000Z'));
  });

  it('does not overwrite the closing snapshot once same-day metrics exist', async () => {
    const service = new CurrentRankService({} as any, {} as any) as any;
    jest.spyOn(service, 'getLatestMetricTradeDate').mockResolvedValue(new Date('2026-10-15'));
    const create = jest.spyOn(service, 'createCurrentRankSnapshot');

    const result = await service.createClosingSnapshot(new Date('2026-10-15'));

    expect(result).toMatchObject({ success: false });
    expect(create).not.toHaveBeenCalled();
  });

  it('rebuilds a historical closing snapshot from the metric close of that date, not current prices', async () => {
    const currentPriceService = { getCurrentPrices: jest.fn(() => { throw new Error('current prices must not be read'); }) };
    const service = new CurrentRankService(
      {} as any,
      currentPriceService as any,
    ) as any;
    jest.spyOn(service, 'getStaticFilteredMetrics').mockResolvedValue([{
      stock_code: '041830', trade_date: new Date('2026-08-10'), close_price: '30800',
      relative_strength_score: '90', rank: 1, high_price_52w: '35000',
      low_price_52w: '20000', ma_50: '25000', price_change_rate_1d: '2.5',
      price_change_1d: '750', trading_value: 12_000n, is_new_high: false,
      short_term_rs: '88.67',
    }]);
    jest.spyOn(service, 'getPreviousTradingValues').mockResolvedValue(new Map());
    const save = jest.spyOn(service, 'saveSnapshotRows').mockResolvedValue(undefined);

    const result = await service.rebuildClosingSnapshot(new Date('2026-08-10'));

    expect(result).toMatchObject({
      success: true,
      tradeDate: '2026-08-10',
      snapshotTime: '2026-08-10T06:50:00.000Z',
    });
    expect(save.mock.calls[0][0][0]).toMatchObject({
      currentPrice: 30_800,
      priceSource: 'close',
    });
    expect(currentPriceService.getCurrentPrices).not.toHaveBeenCalled();
  });
});
