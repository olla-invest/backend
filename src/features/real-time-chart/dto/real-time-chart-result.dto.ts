import { MarketType } from '@generated/prisma';

export class InvestmentIndicator {
    type: 'VOLATILITY_CONTRACTION' | 'STRENGTH_PERSISTENCE' | 'PRICE_COMPRESSION';
    label: string;
    value?: string; // e.g. "7/10"
}

export class RankChange {
    d1: number | null; // D-1 순위
    d2: number | null; // D-2 순위
    d3: number | null; // D-3 순위
}

export class RealTimeChartResultItem {
    rank: number;                     // 순위
    companyId: string;
    companyName: string;              // 기업명
    stockCode: string;
    marketType: MarketType;           // 거래소
    rsScore: number;                  // 시장대비강도 점수 (1-99)
    isNewHigh: boolean;               // 신고가 여부
    currentPrice: number;             // 현재가
    priceChangeRate: number;          // 등락률 (%)
    indicators: InvestmentIndicator[]; // 투자 중요지표
    rankChange: RankChange;           // 순위변동 (최근 3일)
}

export class RealTimeChartResultDto {
    items: RealTimeChartResultItem[];
    total: number;
    page: number;
    limit: number;
    updatedAt: Date;
}
