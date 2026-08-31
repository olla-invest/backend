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
});
