/**
 * 순위변동(최근 3일) 누적 상승폭 계산 유틸
 *
 * 정렬 기준 = 3일 누적 상승폭 (순위가 존재하는 구간만 누적)
 * - 보유한 순위 시점들을 시간순으로 두고, 연속한 두 시점의 변동을 합산
 *   → 누적 상승폭 = Σ (이전 시점 순위 − 다음 시점 순위)
 * - 순위권 밖에서 진입한 구간은 직전 순위를 해당 시점의 전체 선별 종목수(N)+1로 간주
 *   (N은 고정값이 아니라 해당 시점의 전체 종목 수로 매번 동적 산출)
 */

export interface RankChangePoint {
  /** 해당 시점 순위 (null = 순위권 밖) */
  rank: number | null;
  /** 해당 시점 전체 선별 종목수 N (null = 데이터 없음) */
  total: number | null;
}

/**
 * 시간순(과거 → 오늘) 시점 배열로 누적 상승폭을 계산한다.
 * 모든 시점이 순위권 밖이면 null을 반환한다.
 */
export function computeCumulativeRankChange(points: RankChangePoint[]): number | null {
  const held = points
    .map((point, index) => ({ ...point, index }))
    .filter((point) => point.rank != null);

  if (held.length === 0) return null;

  let sum = 0;

  // 순위권 밖에서 진입: 첫 보유 시점이 윈도우 시작이 아니면 직전 순위를 N+1로 간주
  const first = held[0];
  if (first.index > 0 && first.total != null) {
    sum += first.total + 1 - first.rank!;
  }

  for (let i = 1; i < held.length; i++) {
    sum += held[i - 1].rank! - held[i].rank!;
  }

  return sum;
}

/**
 * D-1이 인덱스 0인 최근순 이력/총계 배열과 오늘 값으로
 * computeCumulativeRankChange 입력(시간순 시점 배열)을 구성한다.
 */
export function buildRankChangePoints(
  recentHistory: Array<number | null>,
  recentTotals: Array<number | null>,
  todayRank: number | null,
  todayTotal: number | null,
  days = 3,
): RankChangePoint[] {
  const points: RankChangePoint[] = [];
  for (let i = days - 1; i >= 0; i--) {
    points.push({ rank: recentHistory[i] ?? null, total: recentTotals[i] ?? null });
  }
  points.push({ rank: todayRank, total: todayTotal });
  return points;
}

/**
 * null 값을 정렬 방향과 무관하게 항상 뒤로 보내는 정렬.
 * 동률은 tieBreak(원본 기준 순서) 오름차순.
 */
export function sortWithNullsLast<T>(
  items: T[],
  valueOf: (item: T) => number | null,
  order: 'asc' | 'desc',
  tieBreak: (item: T) => number,
): T[] {
  const direction = order === 'asc' ? 1 : -1;
  return [...items].sort((a, b) => {
    const av = valueOf(a);
    const bv = valueOf(b);
    if (av == null && bv == null) return tieBreak(a) - tieBreak(b);
    if (av == null) return 1;
    if (bv == null) return -1;
    if (av !== bv) return (av - bv) * direction;
    return tieBreak(a) - tieBreak(b);
  });
}
