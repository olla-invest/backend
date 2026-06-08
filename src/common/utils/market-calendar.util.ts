/**
 * KRX (한국거래소) 시장 캘린더 유틸
 *
 * - 주말(토/일) + 한국 거래소 휴장일을 거래일에서 제외
 * - 휴장일 데이터는 KRX 공식 공지에 따라 매년 갱신 필요
 *   (https://open.krx.co.kr/contents/MKD/01/0110/01100305/MKD01100305.jsp)
 *
 * 데이터 출처: KRX 휴장일 안내 (대체공휴일 포함, 주말 중복 제거)
 */

/**
 * 연도별 KRX 휴장일 (YYYY-MM-DD)
 * - 주말 제외, 평일에 해당하는 휴장일만 등록
 * - 새해(1/1), 설날(음력 1/1 전후), 어린이날(5/5), 부처님오신날, 현충일(6/6),
 *   광복절(8/15), 추석(음력 8/15 전후), 개천절(10/3), 한글날(10/9), 크리스마스(12/25),
 *   12월 마지막 평일(연말 휴장) 포함
 */
const KRX_HOLIDAYS: Record<number, string[]> = {
  2024: [
    '2024-01-01', '2024-02-09', '2024-02-12',
    '2024-03-01', '2024-04-10', '2024-05-01', '2024-05-06', '2024-05-15',
    '2024-06-06', '2024-08-15', '2024-09-16', '2024-09-17', '2024-09-18',
    '2024-10-01', '2024-10-03', '2024-10-09', '2024-12-25', '2024-12-31',
  ],
  2025: [
    '2025-01-01', '2025-01-28', '2025-01-29', '2025-01-30',
    '2025-03-03', '2025-05-01', '2025-05-05', '2025-05-06',
    '2025-06-06', '2025-08-15', '2025-10-03', '2025-10-06', '2025-10-07', '2025-10-08', '2025-10-09',
    '2025-12-25', '2025-12-31',
  ],
  2026: [
    '2026-01-01', '2026-02-16', '2026-02-17', '2026-02-18',
    '2026-03-02', '2026-05-01', '2026-05-05', '2026-05-25',
    '2026-06-03', '2026-08-17', '2026-09-24', '2026-09-25', '2026-09-28',
    '2026-10-05', '2026-10-09', '2026-12-25', '2026-12-31',
  ],
  2027: [
    '2027-01-01', '2027-02-08', '2027-02-09', '2027-03-01',
    '2027-05-05', '2027-05-13', '2027-08-16',
    '2027-09-15', '2027-09-16', '2027-09-17',
    '2027-10-04', '2027-10-11', '2027-12-31',
  ],
};

/**
 * Date 객체를 KST 기준 YYYY-MM-DD 문자열로 변환
 */
function toKstDateString(date: Date): string {
  const kst = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  return kst.toISOString().split('T')[0];
}

/**
 * 해당 날짜가 KRX 거래일인지 확인
 *
 * @param date 검사할 날짜 (시간대 무관, 내부에서 KST로 변환)
 * @returns 거래일이면 true, 주말/휴장일이면 false
 */
export function isKrxTradingDay(date: Date = new Date()): boolean {
  const kst = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  const day = kst.getUTCDay(); // 0=일, 6=토
  if (day === 0 || day === 6) return false;

  const year = kst.getUTCFullYear();
  const dateStr = toKstDateString(date);
  const holidays = KRX_HOLIDAYS[year];
  if (!holidays) {
    // 해당 연도 데이터가 없으면 보수적으로 거래일로 간주하되 경고는 호출측에서 처리
    return true;
  }
  return !holidays.includes(dateStr);
}

/**
 * 직전 거래일 반환 (today 이전 기준)
 */
export function previousTradingDay(today: Date = new Date()): Date {
  const d = new Date(today);
  d.setUTCDate(d.getUTCDate() - 1);
  while (!isKrxTradingDay(d)) {
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return d;
}

/**
 * 기준일에서 N거래일 전/현재 거래일 날짜 문자열 반환.
 * - offset=0: 기준일이 거래일이면 기준일, 아니면 직전 거래일
 * - offset=63: 기준일 포함 카운트에서 63칸 전 거래일
 */
export function getKrxTradingDateByOffset(baseDate: Date | string, offset: number): string {
  const baseDateString = typeof baseDate === 'string'
    ? baseDate
    : baseDate.toISOString().split('T')[0];
  const d = new Date(`${baseDateString}T00:00:00.000Z`);
  let count = 0;

  while (true) {
    if (isKrxTradingDay(d)) {
      if (count === offset) return d.toISOString().split('T')[0];
      count++;
    }
    d.setUTCDate(d.getUTCDate() - 1);
  }
}

/**
 * 두 날짜 사이의 거래일 개수 (start 포함, end 포함)
 */
export function tradingDaysBetween(start: Date, end: Date): number {
  let count = 0;
  const d = new Date(start);
  while (d.getTime() <= end.getTime()) {
    if (isKrxTradingDay(d)) count++;
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return count;
}

/**
 * 등록된 휴장일 연도 범위 확인 (운영 알람용)
 */
export function getSupportedYears(): number[] {
  return Object.keys(KRX_HOLIDAYS).map(Number).sort((a, b) => a - b);
}
