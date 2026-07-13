import {
  buildRankChangePoints,
  computeCumulativeRankChange,
  sortWithNullsLast,
} from './rank-change.util';

describe('computeCumulativeRankChange', () => {
  // 스펙 예시 i) 3일 다 있음 (D-3=28, D-2=15, D-1=3, 오늘=1)
  // → (28−15)+(15−3)+(3−1) = +27
  it('sums consecutive held-point changes when all points exist', () => {
    const points = [
      { rank: 28, total: 150 },
      { rank: 15, total: 148 },
      { rank: 3, total: 152 },
      { rank: 1, total: 150 },
    ];
    expect(computeCumulativeRankChange(points)).toBe(27);
  });

  // 스펙 예시 ii) D-3 없음·D-2부터 있음, 진입 시점 N=120 (D-2=40, D-1=12, 오늘=5)
  // → (121−40)+(40−12)+(12−5) = +116
  it('treats entry from outside as N+1 at the first held point', () => {
    const points = [
      { rank: null, total: 130 },
      { rank: 40, total: 120 },
      { rank: 12, total: 125 },
      { rank: 5, total: 118 },
    ];
    expect(computeCumulativeRankChange(points)).toBe(116);
  });

  // 스펙 예시 iii) 오늘 첫 진입, 오늘 시점 N=120 (오늘=5) → (121−5) = +116
  it('handles first entry today', () => {
    const points = [
      { rank: null, total: 130 },
      { rank: null, total: 120 },
      { rank: null, total: 125 },
      { rank: 5, total: 120 },
    ];
    expect(computeCumulativeRankChange(points)).toBe(116);
  });

  it('returns null when no point is held', () => {
    const points = [
      { rank: null, total: 120 },
      { rank: null, total: 120 },
      { rank: null, total: 120 },
      { rank: null, total: 120 },
    ];
    expect(computeCumulativeRankChange(points)).toBeNull();
  });

  it('applies no entry adjustment when the window starts with a held point', () => {
    // D-3부터 보유 → 예시 i와 동일하게 N+1 보정 없음
    const points = [
      { rank: 10, total: 100 },
      { rank: 5, total: 100 },
      { rank: 3, total: 100 },
      { rank: 1, total: 100 },
    ];
    expect(computeCumulativeRankChange(points)).toBe(9);
  });

  it('skips entry adjustment when total is unavailable at the first held point', () => {
    const points = [
      { rank: null, total: null },
      { rank: 40, total: null },
      { rank: 12, total: 125 },
      { rank: 5, total: 118 },
    ];
    // (40−12)+(12−5) = 35, 진입 보정은 N을 알 수 없어 생략
    expect(computeCumulativeRankChange(points)).toBe(35);
  });

  it('pairs held points across a middle gap', () => {
    // 보유 시점(시간순): D-3=20, 오늘=10 → (20−10) = +10
    const points = [
      { rank: 20, total: 100 },
      { rank: null, total: 100 },
      { rank: null, total: 100 },
      { rank: 10, total: 100 },
    ];
    expect(computeCumulativeRankChange(points)).toBe(10);
  });

  it('returns negative sum when rank declines', () => {
    const points = [
      { rank: 1, total: 100 },
      { rank: 5, total: 100 },
      { rank: 12, total: 100 },
      { rank: 30, total: 100 },
    ];
    expect(computeCumulativeRankChange(points)).toBe(-29);
  });
});

describe('buildRankChangePoints', () => {
  it('converts recent-first history into time-ascending points with today appended', () => {
    // history/totals는 D-1이 인덱스 0
    const history = [3, 15, 28];
    const totals = [152, 148, 150];
    const points = buildRankChangePoints(history, totals, 1, 150);
    expect(points).toEqual([
      { rank: 28, total: 150 }, // D-3
      { rank: 15, total: 148 }, // D-2
      { rank: 3, total: 152 }, // D-1
      { rank: 1, total: 150 }, // 오늘
    ]);
  });

  it('fills missing history entries with null', () => {
    const points = buildRankChangePoints([12, 40], [125, 120], 5, 118);
    expect(points).toEqual([
      { rank: null, total: null },
      { rank: 40, total: 120 },
      { rank: 12, total: 125 },
      { rank: 5, total: 118 },
    ]);
  });
});

describe('sortWithNullsLast', () => {
  interface Item {
    code: string;
    value: number | null;
    baseRank: number;
  }
  const items: Item[] = [
    { code: 'A', value: 3, baseRank: 1 },
    { code: 'B', value: null, baseRank: 2 },
    { code: 'C', value: 10, baseRank: 3 },
    { code: 'D', value: -2, baseRank: 4 },
    { code: 'E', value: 3, baseRank: 5 },
  ];
  const valueOf = (item: Item) => item.value;
  const tieBreak = (item: Item) => item.baseRank;

  it('sorts descending with nulls last and stable tie-break', () => {
    const sorted = sortWithNullsLast(items, valueOf, 'desc', tieBreak);
    expect(sorted.map((i) => i.code)).toEqual(['C', 'A', 'E', 'D', 'B']);
  });

  it('sorts ascending with nulls still last', () => {
    const sorted = sortWithNullsLast(items, valueOf, 'asc', tieBreak);
    expect(sorted.map((i) => i.code)).toEqual(['D', 'A', 'E', 'C', 'B']);
  });

  it('does not mutate the input array', () => {
    const original = items.map((i) => i.code);
    sortWithNullsLast(items, valueOf, 'desc', tieBreak);
    expect(items.map((i) => i.code)).toEqual(original);
  });
});
