import { ThemeSnapshotService } from './theme-snapshot.service';

describe('ThemeSnapshotService', () => {
  it('aggregates one exact stock snapshot and includes eligible stocks below RS80', async () => {
    const deleteMany = jest.fn().mockResolvedValue({ count: 0 });
    const createMany = jest.fn().mockResolvedValue({ count: 2 });
    const prisma: any = {
      $queryRawUnsafe: jest.fn()
        .mockResolvedValueOnce([{ snapshot_time: new Date('2026-08-10T06:50:00.000Z') }])
        .mockResolvedValueOnce([
          ...[
            [95, 13.42], [87, 9.66], [82, -1.84], [73, 13.30],
            [73, 2.70], [32, 11.44], [29, -0.43],
          ].map(([rs, change], index) => ({
            theme_code: 34, stock_code: `OLED-${index}`, rs_score: String(rs),
            change_rate: String(change), trading_value: 100n,
            previous_trading_value_ratio: null, is_new_high: false,
          })),
          {
            theme_code: 1, stock_code: 'OTHER', rs_score: '99', change_rate: '15',
            trading_value: 100n, previous_trading_value_ratio: null, is_new_high: true,
          },
        ]),
      themeDailySnapshot: { deleteMany, createMany },
      $transaction: jest.fn(async (callback: any) => callback({
        themeDailySnapshot: { deleteMany, createMany },
      })),
    };
    const service = new ThemeSnapshotService(prisma);

    const result = await service.buildDailySnapshot(new Date('2026-08-10'));

    expect(result).toEqual({
      saved: 2,
      tradeDate: '2026-08-10',
      stockSnapshotTime: '2026-08-10T06:50:00.000Z',
    });
    const rows = createMany.mock.calls[0][0].data;
    const oled = rows.find((row: any) => row.themeCode === 34);
    expect(oled).toMatchObject({
      rank: 2,
      totalCount: 7,
      risingCount: 5,
      upCount: 5,
      flatCount: 0,
      downCount: 2,
      stockSnapshotTime: new Date('2026-08-10T06:50:00.000Z'),
    });
    expect(oled.avgRsScore).toBeCloseTo(67.29, 2);
    expect(prisma.$queryRawUnsafe.mock.calls[1][1]).toBe('2026-08-10');
    expect(prisma.$queryRawUnsafe.mock.calls[1][2]).toBe('2026-08-10T06:50:00.000Z');
  });

  it('refuses to build a partial theme snapshot without a stock snapshot source', async () => {
    const prisma: any = {
      $queryRawUnsafe: jest.fn().mockResolvedValue([]),
    };
    const service = new ThemeSnapshotService(prisma);

    await expect(service.buildDailySnapshot(new Date('2026-08-10')))
      .rejects.toThrow('stock snapshot not found for 2026-08-10');
  });

  it('aggregates grouped themes through their child theme memberships', async () => {
    const createMany = jest.fn().mockResolvedValue({ count: 1 });
    const prisma: any = {
      $queryRawUnsafe: jest.fn()
        .mockResolvedValueOnce([{ snapshot_time: new Date('2026-08-10T06:50:00.000Z') }])
        .mockResolvedValueOnce([{
          theme_code: 200001, stock_code: 'OLED-A', rs_score: '73', change_rate: '2.5',
          trading_value: 100n, previous_trading_value_ratio: null, is_new_high: false,
        }]),
      $transaction: jest.fn(async (callback: any) => callback({
        themeDailySnapshot: { deleteMany: jest.fn(), createMany },
      })),
    };
    const service = new ThemeSnapshotService(prisma);

    await service.buildDailySnapshot(new Date('2026-08-10'));

    const sourceSql = prisma.$queryRawUnsafe.mock.calls[1][0];
    expect(sourceSql).toContain('theme_group_themes');
    expect(createMany.mock.calls[0][0].data[0]).toMatchObject({
      themeCode: 200001,
      totalCount: 1,
      avgRsScore: 73,
    });
  });

  it('loads list stocks for multiple themes from one exact stock snapshot query', async () => {
    const prisma: any = {
      $queryRawUnsafe: jest.fn().mockResolvedValue([
        { theme_code: 1, stock_code: 'A', current_rank: 2, current_price: '100',
          relative_strength_score: '90', price_change_rate: '5', trading_value: 1000n,
          previous_trading_value_ratio: '2', is_new_high: true, short_term_rs: '88' },
        { theme_code: 2, stock_code: 'B', current_rank: 3, current_price: '80',
          relative_strength_score: '70', price_change_rate: '-1', trading_value: 500n,
          previous_trading_value_ratio: null, is_new_high: false, short_term_rs: null },
      ]),
    };
    const service = new ThemeSnapshotService(prisma);

    const result = await (service as any).getThemeStocksForThemes(
      [1, 2],
      new Date('2026-08-10'),
      new Date('2026-08-10T06:50:00.000Z'),
    );

    expect(result.get(1)).toEqual([expect.objectContaining({ stockCode: 'A', shortTermRs: 88 })]);
    expect(result.get(2)).toEqual([expect.objectContaining({ stockCode: 'B', shortTermRs: null })]);
    expect(prisma.$queryRawUnsafe).toHaveBeenCalledTimes(1);
  });
});
