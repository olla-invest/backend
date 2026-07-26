import { ThemeMetricsService } from './theme-metrics.service';

describe('ThemeMetricsService', () => {
  const service = new ThemeMetricsService();

  it('deduplicates stocks and aggregates only RS80 stocks', () => {
    const result = service.calculateDailyMetric([
      { stockCode: 'A', rsScore: 90, changeRate: 2, isNewHigh: true },
      { stockCode: 'A', rsScore: 91, changeRate: 3, isNewHigh: true },
      { stockCode: 'B', rsScore: 80, changeRate: -1, isNewHigh: false },
      { stockCode: 'C', rsScore: 79, changeRate: 20, isNewHigh: true },
    ], []);

    expect(result).toMatchObject({
      isEligible: true,
      stockCount: 3,
      eligibleStockCount: 2,
      risingCount: 1,
      newHighCount: 1,
      rsScore: 85.5,
      changeRate: 1,
    });
  });

  it('requires two RS80 stocks', () => {
    const result = service.calculateDailyMetric([
      { stockCode: 'A', rsScore: 90, changeRate: 2, isNewHigh: false },
      { stockCode: 'B', rsScore: 79, changeRate: 3, isNewHigh: false },
    ], []);

    expect(result.isEligible).toBe(false);
  });

  it('calculates three-day RS and 63-day momentum', () => {
    const history = Array.from({ length: 63 }, (_, index) => ({
      tradeDate: `2026-05-${String(index + 1).padStart(2, '0')}`,
      avgRsScore: index >= 60 ? 90 : 80,
    }));
    const result = service.calculateDailyMetric([
      { stockCode: 'A', rsScore: 90, changeRate: 2, isNewHigh: false },
      { stockCode: 'B', rsScore: 85, changeRate: 1, isNewHigh: false },
    ], history);

    expect(result.shortTermRs).toBe(90);
    expect(result.momentum).toBe(9.52);
  });

  it('returns null history metrics when fewer than three dates exist', () => {
    const result = service.calculateDailyMetric([
      { stockCode: 'A', rsScore: 90, changeRate: 2, isNewHigh: false },
      { stockCode: 'B', rsScore: 85, changeRate: 1, isNewHigh: false },
    ], [
      { tradeDate: '2026-07-24', avgRsScore: 80 },
      { tradeDate: '2026-07-25', avgRsScore: 82 },
    ]);

    expect(result.shortTermRs).toBeNull();
    expect(result.momentum).toBeNull();
  });

  it.each([
    ['continues strong streak', 0.8, { direction: 'STRONG', days: 3, tone: 'RED' }],
    ['uses orange after four strong days', 1, { direction: 'STRONG', days: 4, tone: 'ORANGE' }],
    ['restarts after direction reversal', -0.8, { direction: 'WEAK', days: 1, tone: null }],
    ['resets on neutral', 0.1, { direction: 'NEUTRAL', days: 0, tone: null }],
  ])('%s', (_name, changeRate, expected) => {
    const previous = { direction: 'STRONG' as const, days: expected.days === 4 ? 3 : 2 };
    expect(service.calculateStreak(changeRate as number, previous)).toMatchObject(expected);
  });

  it('shows blue only from the second weak day', () => {
    expect(service.calculateStreak(-1, { direction: 'WEAK', days: 1 })).toMatchObject({
      direction: 'WEAK', days: 2, tone: 'BLUE', label: '2일 연속 약세',
    });
  });

  it('returns the top three related themes by Jaccard similarity', () => {
    const related = service.calculateRelatedThemes(
      { themeCode: 1, rsScore: 90, stockCodes: ['A', 'B', 'C', 'D'] },
      [
        { themeCode: 1, themeName: 'self', rsScore: 99, changeRate: 9, stockCodes: ['A', 'B'] },
        { themeCode: 2, themeName: 'two', rsScore: 80, changeRate: 2, stockCodes: ['A', 'B', 'C'] },
        { themeCode: 3, themeName: 'three', rsScore: 95, changeRate: -2, stockCodes: ['A', 'B', 'X'] },
        { themeCode: 4, themeName: 'four', rsScore: 70, changeRate: 0, stockCodes: ['A', 'B', 'Y', 'Z'] },
        { themeCode: 5, themeName: 'one-shared', rsScore: 100, changeRate: 5, stockCodes: ['A', 'Q'] },
        { themeCode: 6, themeName: 'six', rsScore: 60, changeRate: 1, stockCodes: ['A', 'B', 'C', 'D', 'E'] },
      ],
    );

    expect(related.map((item) => item.themeCode)).toEqual([6, 2, 3]);
    expect(related[0].similarity).toBe(0.8);
    expect(related).toHaveLength(3);
  });
});
