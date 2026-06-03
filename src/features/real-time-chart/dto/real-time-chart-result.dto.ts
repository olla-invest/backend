import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { MarketType } from '@generated/prisma';

export class InvestmentIndicator {
  @ApiProperty({
    enum: ['VOLATILITY_CONTRACTION', 'PRICE_COMPRESSION', 'STRENGTH_CONTINUATION', 'TREND_TEMPLATE'],
    example: 'STRENGTH_CONTINUATION',
    description: '투자 중요지표 타입',
  })
  type: 'VOLATILITY_CONTRACTION' | 'PRICE_COMPRESSION' | 'STRENGTH_CONTINUATION' | 'TREND_TEMPLATE';

  @ApiProperty({ example: '강도 지속', description: '투자 중요지표 표시명' })
  label: string;

  @ApiPropertyOptional({ example: '7/10', description: '보조 표시값' })
  value?: string;
}

export class RankHistoryDto {
  @ApiProperty({ example: 12, nullable: true, description: '오늘 순위' })
  today: number | null;

  @ApiProperty({ example: 18, nullable: true, description: 'D-1 순위' })
  oneDayAgo: number | null;

  @ApiProperty({ example: 31, nullable: true, description: 'D-2 순위' })
  twoDaysAgo: number | null;

  @ApiProperty({ example: 44, nullable: true, description: 'D-3 순위' })
  threeDaysAgo: number | null;
}

export class StockThemeDto {
  @ApiProperty({ example: 100123, description: 'Naver crawled theme code' })
  themeCode: number;

  @ApiProperty({ example: 'Semiconductor', description: 'Naver crawled theme name' })
  themeName: string;
}

export class RealTimeChartResultItem {
  @ApiProperty({ example: '005930', description: '화면 식별자(종목코드)' })
  id: string;

  @ApiProperty({ example: 1, description: '현재 조회 결과 내 순위' })
  rank: number;

  @ApiProperty({ example: '삼성전자', description: '종목명' })
  companyName: string;

  @ApiProperty({ example: '005930', description: '종목코드' })
  stockCode: string;

  @ApiProperty({ example: 'KOSPI', description: '거래소' })
  exchange: string;

  @ApiProperty({ example: 75200, description: '현재가 또는 최신 집계 종가' })
  currentPrice: number;

  @ApiProperty({ example: 98.42, description: '상대강도 점수' })
  relativeStrengthScore: number;

  @ApiProperty({ example: false, description: '신고가 여부' })
  isHighPrice: boolean;

  @ApiProperty({ example: '+3.21%', description: '등락률 표시 문자열' })
  priceChangeRateText: string;

  @ApiProperty({ example: '변동성 축소, 강도 지속 7/10', description: '투자 중요지표 요약 문자열' })
  investmentIndicators: string;

  @ApiProperty({ type: [InvestmentIndicator], description: '투자 중요지표 구조화 목록' })
  investmentIndicatorItems: InvestmentIndicator[];

  @ApiProperty({ example: '변동성 축소, 강도 지속 7/10', description: '투자 중요지표 상세 표시 문자열' })
  investmentIndicatorsDtl: string;

  @ApiProperty({ example: '반도체', description: '테마명' })
  theme: string;

  @ApiProperty({ example: '반도체', description: '업종/테마명 원본' })
  upName: string;

  @ApiProperty({ type: [StockThemeDto], description: 'Naver crawled stock themes' })
  themes: StockThemeDto[];

  @ApiProperty({ type: RankHistoryDto, description: '최근 순위 이력' })
  rankHistory: RankHistoryDto;

  @ApiProperty({ example: true, description: '변동성 축소 여부' })
  isVolatilityContraction: boolean;

  @ApiProperty({ example: false, description: '가격 압축 여부' })
  isPriceCompression: boolean;

  @ApiProperty({ example: 7, nullable: true, description: '최근 10거래일 강도 지속 일수' })
  strengthContinuationDays: number | null;

  @ApiProperty({ example: true, description: '트렌드 템플릿 여부' })
  isTrendTemplate: boolean;
}

export class RealTimeChartMetaDto {
  @ApiProperty({ example: '2026-05-18', nullable: true, description: '집계 기준 거래일' })
  dataDate: string | null;

  @ApiProperty({ example: '2026-05-19T11:11:14.000Z', nullable: true, description: '마지막 데이터 갱신 시각' })
  lastUpdatedAt: string | null;

  @ApiProperty({ example: true, description: '초기화 완료 여부' })
  isInitialized: boolean;

  @ApiProperty({ example: '2026-02-12', nullable: true, description: '조회 기준 시작일' })
  queryStartDate: string | null;

  @ApiProperty({ example: '2026-05-18', nullable: true, description: '조회 기준 종료일' })
  queryEndDate: string | null;

  @ApiPropertyOptional({
    example: { periods: [63, 126, 252], weights: [50, 30, 20] },
    description: '커스텀 RS 조회 시 적용된 기간/가중치',
  })
  customRS?: Record<string, unknown>;

  @ApiPropertyOptional({
    example: {
      filters: [{ rsStartDate: '20260209', rsEndDate: '20260115', strength: 50 }],
      periods: [63],
      weights: [50],
    },
    description: '기간 기반 RS 조회 시 적용된 필터/기간/가중치',
  })
  rangeRS?: Record<string, unknown>;
}

export class RealTimeChartResultDto {
  @ApiProperty({ example: 'all', enum: ['0', '10', 'all'], description: '시장 구분' })
  marketType: MarketType | '0' | '10' | 'all';

  @ApiProperty({ example: 1 })
  page: number;

  @ApiProperty({ example: 50 })
  pageSize: number;

  @ApiProperty({ example: 120 })
  totalCount: number;

  @ApiProperty({ example: 3 })
  totalPages: number;

  @ApiProperty({ example: 50 })
  count: number;

  @ApiProperty({ type: RealTimeChartMetaDto })
  meta: RealTimeChartMetaDto;

  @ApiProperty({ type: [RealTimeChartResultItem] })
  stocks: RealTimeChartResultItem[];
}
