/**
 * 거래대금 단위 정규화 유틸
 *
 * 키움 실시간(0B 필드 14 누적거래대금)·일봉 거래대금은 백만원 단위로 오는 경우가 많고,
 * stock_daily_metrics·일봉 캔들은 원 단위로 저장한다. 두 값을 섞어 비교하면
 * 전일비가 수천만 배로 튀므로(→ DECIMAL(12,4) overflow) 저장·비교 전에 원 단위로 맞춘다.
 *
 * 1천만 미만은 백만원 단위로 보고 ×1,000,000 한다.
 * (정적 필터 통과 종목은 일 거래대금 10억 이상이라 원 단위 값이 이 범위에 들어오지 않는다)
 */
const MILLION_KRW_UNIT_THRESHOLD = 10_000_000n;

export function toNonNegativeBigInt(value: string | number | bigint | null | undefined): bigint {
  if (value == null) return 0n;
  if (typeof value === 'bigint') return value > 0n ? value : 0n;
  const parsed = Number(String(value).replace(/,/g, ''));
  if (!Number.isFinite(parsed) || parsed <= 0) return 0n;
  return BigInt(Math.trunc(parsed));
}

export function normalizeTradingValueToWon(value: string | number | bigint | null | undefined): bigint {
  const raw = toNonNegativeBigInt(value);
  if (raw === 0n) return 0n;
  return raw < MILLION_KRW_UNIT_THRESHOLD ? raw * 1_000_000n : raw;
}
