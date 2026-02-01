import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { MarketType } from '@generated/prisma';
import { Decimal } from '@generated/prisma/runtime/client';
import { RealTimeChartFilterDto, RsPeriodDto, NewHighType } from './dto/real-time-chart-filter.dto';
import {
    RealTimeChartResultDto,
    RealTimeChartResultItem,
    InvestmentIndicator,
    RankChange,
} from './dto/real-time-chart-result.dto';

const DEFAULT_MIN_TRADING_VALUE = 1_000_000_000;
const DEFAULT_RS_BUSINESS_DAYS = 63;

interface StockData {
    companyId: string;
    companyName: string;
    stockCode: string;
    marketType: MarketType;
    prices: PriceRecord[];
}

interface PriceRecord {
    tradeDate: Date;
    closePrice: number;
    highPrice: number;
    lowPrice: number;
    openPrice: number;
    volume: bigint;
    tradingValue: bigint;
}

interface MarketIndexData {
    tradeDate: Date;
    closeIndex: number;
}

@Injectable()
export class RealTimeChartService {
    constructor( private readonly prisma: PrismaService ) {}

    /**
     * 메인 스크리닝 실행
     * 종목 선별 → RS 계산 → 점수화 → 필터링 → 정렬
     */
    async screen( filter: RealTimeChartFilterDto ): Promise<RealTimeChartResultDto> {
        const minTradingValue = filter.minTradingValue ?? DEFAULT_MIN_TRADING_VALUE;
        const queryEndDate = filter.queryEndDate ?? new Date();
        const page = filter.page ?? 1;
        const limit = filter.limit ?? 10;

        // 1. 데이터 조회에 필요한 lookback 기간 계산 (52주 + MA200 여유분)
        const lookbackDate = new Date( queryEndDate );
        lookbackDate.setDate( lookbackDate.getDate() - 600 );

        // 2. 전체 기업 조회 (거래소 필터 적용)
        const companies = await this.prisma.company.findMany( {
            where: {
                deletedAt: null,
                ...( filter.marketType ? { marketType: filter.marketType } : {} ),
            },
        } );

        // 3. 주가 데이터 조회
        const companyIds = companies.map( ( c ) => c.companyId );
        const priceHistories = await this.prisma.stockPriceHistory.findMany( {
            where: {
                companyId: { in: companyIds },
                tradeDate: { gte: lookbackDate, lte: queryEndDate },
            },
            orderBy: { tradeDate: 'asc' },
        } );

        // 4. 시장 지수 데이터 조회
        const [ kospiIndex, kosdaqIndex ] = await Promise.all( [
            this.getMarketIndexData( 'KOSPI', lookbackDate, queryEndDate ),
            this.getMarketIndexData( 'KOSDAQ', lookbackDate, queryEndDate ),
        ] );

        // 5. 기업별 주가 데이터 매핑
        const stockDataMap = new Map<string, StockData>();
        for ( const company of companies ) {
            stockDataMap.set( company.companyId, {
                companyId: company.companyId,
                companyName: company.companyName,
                stockCode: company.stockCode,
                marketType: company.marketType,
                prices: [],
            } );
        }
        for ( const price of priceHistories ) {
            const stock = stockDataMap.get( price.companyId );
            if ( stock ) {
                stock.prices.push( {
                    tradeDate: price.tradeDate,
                    closePrice: this.toNumber( price.closePrice ),
                    highPrice: this.toNumber( price.highPrice ),
                    lowPrice: this.toNumber( price.lowPrice ),
                    openPrice: this.toNumber( price.openPrice ),
                    volume: price.volume,
                    tradingValue: price.tradingValue,
                } );
            }
        }

        // 6. 종목별 RS 계산 및 기본 필터링
        const rsResults: { stock: StockData; rs: number; latestPrice: PriceRecord }[] = [];

        for ( const stock of stockDataMap.values() ) {
            if ( stock.prices.length < 2 ) continue;

            const latestPrice = stock.prices[stock.prices.length - 1];
            const marketIndex = stock.marketType === 'KOSPI' ? kospiIndex : kosdaqIndex;

            // 필터 1: 거래대금 체크
            if ( !this.checkTradingValue( latestPrice, minTradingValue ) ) continue;

            // 필터 2: 52주 조건 체크
            if ( !this.check52WeekConditions( stock.prices ) ) continue;

            // 필터 3: MA200 조건 체크
            if ( !this.checkMA200Condition( stock.prices ) ) continue;

            // RS 계산 (날짜 범위 기반 또는 기본 63영업일)
            const rs = this.calculateWeightedRS( stock.prices, marketIndex, filter.rsPeriods );
            if ( rs === null ) continue;

            rsResults.push( { stock, rs, latestPrice } );
        }

        // 7. RS 점수화 (시장대비강도 점수)
        rsResults.sort( ( a, b ) => b.rs - a.rs );
        const totalStocks = rsResults.length;

        const scoredResults = rsResults.map( ( result, index ) => {
            const percentile = ( ( totalStocks - index ) / totalStocks ) * 100;
            const rsScore = Math.min( 99, Math.max( 1, Math.round( percentile ) ) );
            return { ...result, rsScore };
        } );

        // 8. 신고가 필터링
        const newHighTypes = filter.newHighTypes ?? [ NewHighType.ALL_TIME, NewHighType.YEARLY ];
        const includeNonNewHigh = filter.includeNonNewHigh ?? true;

        const filtered = scoredResults.filter( ( result ) => {
            const isAllTimeHigh = this.checkAllTimeHigh( result.stock.prices );
            const isYearlyHigh = this.checkNewHigh( result.stock.prices );

            const matchesNewHigh =
                ( newHighTypes.includes( NewHighType.ALL_TIME ) && isAllTimeHigh ) ||
                ( newHighTypes.includes( NewHighType.YEARLY ) && isYearlyHigh );

            if ( !matchesNewHigh && !includeNonNewHigh ) return false;
            return true;
        } );

        // 9. 페이지네이션
        const total = filtered.length;
        const offset = ( page - 1 ) * limit;
        const paged = filtered.slice( offset, offset + limit );

        // 10. 결과 조립
        const items: RealTimeChartResultItem[] = paged.map( ( result, index ) => {
            const latestPrice = result.latestPrice;
            const prevPrice = result.stock.prices[result.stock.prices.length - 2];
            const priceChangeRate = prevPrice
                ? ( ( latestPrice.closePrice - prevPrice.closePrice ) / prevPrice.closePrice ) * 100
                : 0;

            return {
                rank: offset + index + 1,
                companyId: result.stock.companyId,
                companyName: result.stock.companyName,
                stockCode: result.stock.stockCode,
                marketType: result.stock.marketType,
                rsScore: result.rsScore,
                isNewHigh: this.checkNewHigh( result.stock.prices ),
                currentPrice: latestPrice.closePrice,
                priceChangeRate: Math.round( priceChangeRate * 100 ) / 100,
                indicators: this.calculateIndicators( result.stock.prices ),
                rankChange: this.calculateRankChange( result.stock.companyId ),
            };
        } );

        return {
            items,
            total,
            page,
            limit,
            updatedAt: queryEndDate,
        };
    }

    // =============================================
    // 필터 조건 체크
    // =============================================

    /**
     * 거래대금 필터: 거래대금 ≥ 설정값
     */
    private checkTradingValue( latestPrice: PriceRecord, minTradingValue: number ): boolean {
        return Number( latestPrice.tradingValue ) >= minTradingValue;
    }

    /**
     * 52주 조건 체크
     * 1) 현재가 ≥ 52주 최저가 × 1.3
     * 2) 현재가 ≥ 0.75 × 52주 최고가
     */
    private check52WeekConditions( prices: PriceRecord[] ): boolean {
        const recent252 = prices.slice( -252 );
        if ( recent252.length < 20 ) return false;

        const currentPrice = recent252[recent252.length - 1].closePrice;
        const week52High = Math.max( ...recent252.map( ( p ) => p.highPrice ) );
        const week52Low = Math.min( ...recent252.map( ( p ) => p.lowPrice ) );

        const condition1 = currentPrice >= week52Low * 1.3;
        const condition2 = currentPrice >= 0.75 * week52High;

        return condition1 && condition2;
    }

    /**
     * MA200 조건: MA200(현재) > MA200(20일 전)
     * → 200일 이동평균이 20일 전보다 상승 추세
     */
    private checkMA200Condition( prices: PriceRecord[] ): boolean {
        if ( prices.length < 220 ) return false;

        const currentMA200 = this.calculateMA( prices, prices.length - 1, 200 );
        const past20MA200 = this.calculateMA( prices, prices.length - 21, 200 );

        if ( currentMA200 === null || past20MA200 === null ) return false;

        return currentMA200 > past20MA200;
    }

    // =============================================
    // RS 계산
    // =============================================

    /**
     * 가중 RS 계산
     * - rsPeriods 설정 시: 각 기간별 날짜 범위 내 영업일 기준 RS 가중평균
     * - rsPeriods 미설정 시: 기본 63영업일 RS
     */
    private calculateWeightedRS(
        prices: PriceRecord[],
        marketIndex: MarketIndexData[],
        rsPeriods?: RsPeriodDto[],
    ): number | null {
        // 기본값: 63영업일 RS
        if ( !rsPeriods?.length ) {
            return this.calculateRSByPeriod( prices, marketIndex, DEFAULT_RS_BUSINESS_DAYS );
        }

        const totalWeight = rsPeriods.reduce( ( sum, rp ) => sum + rp.weight, 0 );
        if ( totalWeight === 0 ) return null;

        let weightedRS = 0;

        for ( const rp of rsPeriods ) {
            // 날짜 범위 내 영업일 수 계산
            const businessDays = this.countBusinessDays( prices, rp.startDate, rp.endDate );
            if ( businessDays < 1 ) return null;

            const rs = this.calculateRSByPeriod( prices, marketIndex, businessDays );
            if ( rs === null ) return null;
            weightedRS += rs * ( rp.weight / totalWeight );
        }

        return weightedRS;
    }

    /**
     * 영업일 수 기반 RS 계산
     * RS(N) = (현재 종가 / N영업일 전 종가) / (현재 지수 / N영업일 전 지수)
     */
    private calculateRSByPeriod(
        prices: PriceRecord[],
        marketIndex: MarketIndexData[],
        businessDays: number,
    ): number | null {
        if ( prices.length <= businessDays ) return null;

        const currentPrice = prices[prices.length - 1];
        const pastPrice = prices[prices.length - 1 - businessDays];

        if ( !currentPrice || !pastPrice || pastPrice.closePrice === 0 ) return null;

        const stockReturn = currentPrice.closePrice / pastPrice.closePrice;

        const currentIndex = this.findClosestIndex( marketIndex, currentPrice.tradeDate );
        const pastIndex = this.findClosestIndex( marketIndex, pastPrice.tradeDate );

        if ( !currentIndex || !pastIndex || pastIndex.closeIndex === 0 ) return null;

        const marketReturn = currentIndex.closeIndex / pastIndex.closeIndex;

        return stockReturn / marketReturn;
    }

    /**
     * 날짜 범위 내 영업일 수 계산 (실제 거래일 데이터 기준)
     */
    private countBusinessDays( prices: PriceRecord[], startDate: Date, endDate: Date ): number {
        return prices.filter( ( p ) =>
            p.tradeDate >= startDate && p.tradeDate <= endDate,
        ).length;
    }

    // =============================================
    // 신고가 체크
    // =============================================

    /**
     * 52주 신고가 여부
     */
    private checkNewHigh( prices: PriceRecord[] ): boolean {
        const recent252 = prices.slice( -252 );
        if ( recent252.length < 2 ) return false;

        const currentPrice = recent252[recent252.length - 1].closePrice;
        const week52High = Math.max( ...recent252.map( ( p ) => p.highPrice ) );

        return currentPrice >= week52High;
    }

    /**
     * 전체기간 신고가 여부
     */
    private checkAllTimeHigh( prices: PriceRecord[] ): boolean {
        if ( prices.length < 2 ) return false;

        const currentPrice = prices[prices.length - 1].closePrice;
        const allTimeHigh = Math.max( ...prices.map( ( p ) => p.highPrice ) );

        return currentPrice >= allTimeHigh;
    }

    // =============================================
    // 투자 중요지표 계산
    // =============================================

    /**
     * 투자 중요지표:
     * - 변동성 축소: 최근 10일 ATR이 이전 20일 ATR 대비 축소
     * - 강도 지속: 최근 10일 중 전일 대비 상승 일수 (N/10)
     * - 가격 압축: 최근 10일 고저 범위가 이전 20일 대비 축소
     */
    private calculateIndicators( prices: PriceRecord[] ): InvestmentIndicator[] {
        const indicators: InvestmentIndicator[] = [];

        if ( prices.length < 30 ) return indicators;

        const volatilityContraction = this.checkVolatilityContraction( prices );
        if ( volatilityContraction ) {
            indicators.push( {
                type: 'VOLATILITY_CONTRACTION',
                label: '변동성 축소',
            } );
        }

        const strengthDays = this.checkStrengthPersistence( prices );
        if ( strengthDays >= 5 ) {
            indicators.push( {
                type: 'STRENGTH_PERSISTENCE',
                label: '강도 지속',
                value: `${strengthDays}/10`,
            } );
        }

        const priceCompression = this.checkPriceCompression( prices );
        if ( priceCompression ) {
            indicators.push( {
                type: 'PRICE_COMPRESSION',
                label: '가격 압축',
            } );
        }

        return indicators;
    }

    private checkVolatilityContraction( prices: PriceRecord[] ): boolean {
        const recent10 = prices.slice( -10 );
        const prev20 = prices.slice( -30, -10 );

        const recentATR = this.calculateATR( recent10 );
        const prevATR = this.calculateATR( prev20 );

        if ( prevATR === 0 ) return false;
        return recentATR < prevATR * 0.7;
    }

    private checkStrengthPersistence( prices: PriceRecord[] ): number {
        const recent10 = prices.slice( -10 );
        let upDays = 0;

        for ( let i = 1; i < recent10.length; i++ ) {
            if ( recent10[i].closePrice > recent10[i - 1].closePrice ) {
                upDays++;
            }
        }

        return upDays;
    }

    private checkPriceCompression( prices: PriceRecord[] ): boolean {
        const recent10 = prices.slice( -10 );
        const prev20 = prices.slice( -30, -10 );

        const recentRange = this.calculatePriceRange( recent10 );
        const prevRange = this.calculatePriceRange( prev20 );

        if ( prevRange === 0 ) return false;
        return recentRange < prevRange * 0.5;
    }

    // =============================================
    // 순위변동 (최근 3일)
    // =============================================

    /**
     * 순위변동 계산 (TODO: 일별 스냅샷 테이블 추가 후 구현)
     */
    private calculateRankChange( _companyId: string ): RankChange {
        return { d1: null, d2: null, d3: null };
    }

    // =============================================
    // 유틸리티
    // =============================================

    private calculateMA( prices: PriceRecord[], endIndex: number, period: number ): number | null {
        if ( endIndex < period - 1 || endIndex >= prices.length ) return null;

        let sum = 0;
        for ( let i = endIndex - period + 1; i <= endIndex; i++ ) {
            sum += prices[i].closePrice;
        }

        return sum / period;
    }

    private calculateATR( prices: PriceRecord[] ): number {
        if ( prices.length < 2 ) return 0;

        let totalRange = 0;
        for ( let i = 1; i < prices.length; i++ ) {
            const tr = Math.max(
                prices[i].highPrice - prices[i].lowPrice,
                Math.abs( prices[i].highPrice - prices[i - 1].closePrice ),
                Math.abs( prices[i].lowPrice - prices[i - 1].closePrice ),
            );
            totalRange += tr;
        }

        return totalRange / ( prices.length - 1 );
    }

    private calculatePriceRange( prices: PriceRecord[] ): number {
        if ( prices.length === 0 ) return 0;

        const high = Math.max( ...prices.map( ( p ) => p.highPrice ) );
        const low = Math.min( ...prices.map( ( p ) => p.lowPrice ) );

        if ( low === 0 ) return 0;
        return ( high - low ) / low;
    }

    private findClosestIndex( marketIndex: MarketIndexData[], targetDate: Date ): MarketIndexData | null {
        if ( marketIndex.length === 0 ) return null;

        const target = targetDate.getTime();
        let closest = marketIndex[0];
        let minDiff = Math.abs( closest.tradeDate.getTime() - target );

        for ( const idx of marketIndex ) {
            const diff = Math.abs( idx.tradeDate.getTime() - target );
            if ( diff < minDiff ) {
                minDiff = diff;
                closest = idx;
            }
        }

        return closest;
    }

    private toNumber( value: Decimal ): number {
        return Number( value );
    }

    private async getMarketIndexData(
        marketType: 'KOSPI' | 'KOSDAQ',
        startDate: Date,
        endDate: Date,
    ): Promise<MarketIndexData[]> {
        const data = await this.prisma.marketIndexHistory.findMany( {
            where: {
                marketType,
                tradeDate: { gte: startDate, lte: endDate },
            },
            orderBy: { tradeDate: 'asc' },
        } );

        return data.map( ( d ) => ( {
            tradeDate: d.tradeDate,
            closeIndex: Number( d.closeIndex ),
        } ) );
    }
}
