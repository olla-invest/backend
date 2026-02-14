/**
 * 테마(업종) 코드 상수
 * 키움 API의 upName 필드를 범위 기반 테마로 분류
 */

export interface ThemeCode {
  code: number;
  name: string;
  description?: string;
}

/**
 * 테마 코드 목록 (범위 기반)
 */
export const THEME_CODES: ThemeCode[] = [
  { code: 0, name: '전체', description: '모든 업종' },
  { code: 100, name: '제조업', description: '제조업 전반' },
  { code: 200, name: '서비스업', description: '서비스업 전반' },
  { code: 300, name: 'IT/기술', description: 'IT 및 기술 산업' },
  { code: 400, name: '금융', description: '금융업' },
  { code: 500, name: '운송/물류', description: '운송 및 물류업' },
  { code: 900, name: '기타', description: '기타 업종' },
];

/**
 * 테마 코드 맵 (빠른 검색용)
 */
export const THEME_CODE_MAP = new Map<number, ThemeCode>(
  THEME_CODES.map((theme) => [theme.code, theme]),
);

/**
 * 테마명으로 코드 찾기
 */
export const THEME_NAME_TO_CODE_MAP = new Map<string, number>(
  THEME_CODES.map((theme) => [theme.name, theme.code]),
);

/**
 * upName을 테마 코드로 변환
 * 키움 API의 upName 값을 범위 기반 테마 코드로 매핑
 *
 * @param upName 키움 API의 업종명
 * @returns 테마 코드 (0=전체, 100=제조업, 200=서비스업, 300=IT/기술, 400=금융, 500=운송/물류, 900=기타)
 */
export function mapUpNameToThemeCode(upName: string): number | null {
  if (!upName || upName === '-') {
    return null;
  }

  const normalized = upName.trim().toLowerCase();

  // 제조업 (100-199)
  if (
    normalized.includes('제약') || normalized.includes('의약') ||
    normalized.includes('금속') || normalized.includes('철강') ||
    normalized.includes('건설') ||
    normalized.includes('자동차') || normalized.includes('운송장비') ||
    normalized.includes('전기') || normalized.includes('전자') ||
    normalized.includes('화학') ||
    normalized.includes('음식료') || normalized.includes('식품') ||
    normalized.includes('섬유') || normalized.includes('의복') || normalized.includes('의류') ||
    normalized.includes('종이') || normalized.includes('목재') ||
    normalized.includes('기계') ||
    normalized.includes('화장품')
  ) {
    return 100;
  }

  // 서비스업 (200-299)
  if (
    normalized.includes('유통') ||
    normalized.includes('서비스') ||
    normalized.includes('통신') ||
    normalized.includes('에너지') || normalized.includes('전력') || normalized.includes('가스') ||
    normalized.includes('엔터') || normalized.includes('미디어') || normalized.includes('방송') ||
    normalized.includes('여행') || normalized.includes('레저') || normalized.includes('관광') ||
    normalized.includes('교육') ||
    normalized.includes('의료') || normalized.includes('헬스케어')
  ) {
    return 200;
  }

  // IT/기술 (300-399)
  if (
    normalized.includes('소프트웨어') || normalized.includes('it') ||
    normalized.includes('반도체') || normalized.includes('디스플레이') ||
    normalized.includes('바이오') ||
    normalized.includes('게임')
  ) {
    return 300;
  }

  // 금융 (400-499)
  if (
    normalized.includes('금융') ||
    normalized.includes('은행') ||
    normalized.includes('증권') ||
    normalized.includes('보험')
  ) {
    return 400;
  }

  // 운송/물류 (500-599)
  if (
    normalized.includes('해운') ||
    normalized.includes('항공') ||
    normalized.includes('물류') ||
    normalized.includes('운송')
  ) {
    return 500;
  }

  // 기타 (900-999)
  return 900;
}

/**
 * 테마 코드 유효성 검증
 */
export function isValidThemeCode(code: number): boolean {
  return THEME_CODE_MAP.has(code);
}
