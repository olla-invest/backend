import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RedisLockService } from '../../common/redis/redis-lock.service';
import { KiwoomRestService } from '../../integrations/kiwoom/rest/kiwoom-rest.service';

type MarketType = 'KOSPI' | 'KOSDAQ';
type Signal = 'GREEN' | 'YELLOW' | 'RED';
type SignalMeta = {
  action: 'BUY' | 'SELL' | 'NEUTRAL';
  actionLabel: '매수' | '매도' | '중립';
  signalLabel: '상승신호' | '하락신호' | '중립';
  colorClass: 'rose-500' | 'blue-500' | 'slate-500';
  inactiveColorClass: 'rose-200' | 'blue-200' | 'slate-200';
};

type StockBreadth = {
  total_count: number;
  rising_count: number;
  flat_count: number;
  falling_count: number;
  below_ma20_ratio: number;
  below_ma200_ratio: number;
  new_high_count: number;
  new_low_count: number;
};

@Injectable()
export class MarketViewService {
    private readonly logger = new Logger( MarketViewService.name );
    private readonly ftdMinChangeRate = 1.7;
    private readonly distributionMinDropRate = -0.2;

    constructor(
    private readonly prisma: PrismaService,
    private readonly kiwoomRest: KiwoomRestService,
    private readonly redisLock: RedisLockService,
    ) {}

    async calculateLatest() {
        const tradeDate = await this.getLatestCommonIndexDate();
        return this.calculateForDate( tradeDate, true );
    }

    async calculateForDate( inputDate: Date, useExternalSources = true ) {
        const tradeDate = this.dateOnly( inputDate );
        const results = [];
        for ( const marketType of [ 'KOSPI', 'KOSDAQ' ] as const ) {
            results.push( await this.calculateMarket( marketType, tradeDate, useExternalSources ) );
        }
        return {
            tradeDate: this.isoDate( tradeDate ),
            markets: results,
            overall: this.buildOverallSignal( results ),
        };
    }

    async backfill( days = 260 ) {
        const normalizedDays = Math.min( Math.max( Math.floor( days ) || 260, 2 ), 1500 );
        const result = await this.redisLock.withLock(
            'cron:lock:market-view-backfill',
            6 * 60 * 60 * 1000,
            async () => {
                const dates = await this.prisma.$queryRawUnsafe<{ trade_date: Date }[]>(
                    `
          SELECT candle_time AS trade_date
          FROM stock_candles
          WHERE candle_type = 'day'
            AND stock_code IN ('INDEX_KOSPI', 'INDEX_KOSDAQ')
          GROUP BY candle_time
          HAVING COUNT(DISTINCT stock_code) = 2
          ORDER BY candle_time DESC
          LIMIT $1
          `,
                    normalizedDays,
                );
                const chronologicalDates = dates.map( ( row ) => row.trade_date ).reverse();
                const latestDate = chronologicalDates[ chronologicalDates.length - 1 ];

                const skipped: string[] = [];
                for ( let index = 0; index < chronologicalDates.length; index++ ) {
                    const tradeDate = chronologicalDates[index];
                    try {
                        await this.calculateForDate(
                            tradeDate,
                            latestDate != null && this.isoDate( tradeDate ) === this.isoDate( latestDate ),
                        );
                    } catch ( error ) {
                        skipped.push( this.isoDate( tradeDate ) );
                        this.logger.warn(
                            `[backfill] ${this.isoDate( tradeDate )} 계산 실패, 건너뜀: ${( error as Error ).message}`,
                        );
                    }
                    if ( ( index + 1 ) % 5 === 0 ) await this.yieldToEventLoop();
                }

                return {
                    days: chronologicalDates.length,
                    from: chronologicalDates[ 0 ] ? this.isoDate( chronologicalDates[ 0 ] ) : null,
                    to: latestDate ? this.isoDate( latestDate ) : null,
                    skipped,
                };
            },
        );
        if ( result == null ) {
            throw new ConflictException( '마켓뷰 백필이 이미 실행 중입니다' );
        }
        return result;
    }

    async getLatest() {
        const latest = await this.prisma.marketViewDailySnapshot.findFirst( {
            orderBy: { tradeDate: 'desc' },
            select: { tradeDate: true },
        } );
        if ( !latest ) throw new NotFoundException( '마켓뷰 집계 데이터가 없습니다' );

        const rows = await this.prisma.marketViewDailySnapshot.findMany( {
            where: { tradeDate: latest.tradeDate },
            orderBy: { marketType: 'asc' },
        } );
        const markets = await Promise.all( rows.map( ( row ) => this.toMarketResponse( row ) ) );

        return {
            tradeDate: this.isoDate( latest.tradeDate ),
            updatedAt: rows.reduce<Date | null>(
                ( latestAt, row ) => !latestAt || row.updatedAt > latestAt ? row.updatedAt : latestAt,
                null,
            ),
            markets,
            overall: this.buildOverallSignal( markets ),
        };
    }

    async getDistributionDays( marketType: MarketType, limit = 25 ) {
        if ( marketType !== 'KOSPI' && marketType !== 'KOSDAQ' ) {
            throw new BadRequestException( 'marketType은 KOSPI 또는 KOSDAQ이어야 합니다' );
        }
        const rows = await this.prisma.marketViewDistributionDay.findMany( {
            where: { marketType, isActive: true },
            orderBy: { tradeDate: 'desc' },
            take: Math.min( Math.max( limit, 1 ), 100 ),
        } );
        return {
            marketType,
            total: rows.length,
            items: rows.map( ( row ) => ( {
                tradeDate: this.isoDate( row.tradeDate ),
                changeRate: Number( row.changeRate ),
                volume: row.volume.toString(),
                isActive: row.isActive,
                removedReason: row.removedReason,
            } ) ),
        };
    }

    private async calculateMarket( marketType: MarketType, tradeDate: Date, useExternalSources: boolean ) {
        const indexCode = marketType === 'KOSPI' ? 'INDEX_KOSPI' : 'INDEX_KOSDAQ';
        const kiwoomMarketType = marketType === 'KOSPI' ? '0' as const : '1' as const;
        const sectorCode = marketType === 'KOSPI' ? '001' as const : '101' as const;

        const indexCandles = await this.prisma.stockCandle.findMany( {
            where: {
                stockCode: indexCode,
                candleType: 'day',
                candleTime: { lte: tradeDate },
            },
            orderBy: { candleTime: 'desc' },
            take: 220,
        } );
        if ( indexCandles.length < 2 || this.isoDate( indexCandles[0].candleTime ) !== this.isoDate( tradeDate ) ) {
            throw new NotFoundException( `${marketType} ${this.isoDate( tradeDate )} 지수 일봉이 없습니다` );
        }

        const currentIndex = indexCandles[0];
        const previousIndex = indexCandles[1];
        const closes = [ ...indexCandles ].reverse().map( ( row ) => Number( row.closePrice ) / 100 );
        const indexClose = Number( currentIndex.closePrice ) / 100;
        const previousClose = Number( previousIndex.closePrice ) / 100;
        const indexChange = indexClose - previousClose;
        const indexChangeRate = previousClose > 0 ? ( indexChange / previousClose ) * 100 : 0;
        const ma20 = this.averageLast( closes, 20 );
        const ma50 = this.averageLast( closes, 50 );
        const ma200 = this.averageLast( closes, 200 );
        const stockBreadth = await this.getStockBreadth( marketType, tradeDate );
        const previousSnapshot = await this.prisma.marketViewDailySnapshot.findFirst( {
            where: { marketType, tradeDate: { lt: tradeDate } },
            orderBy: { tradeDate: 'desc' },
        } );

        const sourceErrors: string[] = [];
        const [ sectorResult, investorResult, highResult, lowResult ] = await Promise.allSettled( [
            useExternalSources
                ? this.kiwoomRest.getSectorCurrentPrice( kiwoomMarketType, sectorCode )
                : Promise.resolve( null ),
            useExternalSources
                ? this.kiwoomRest.getMarketInvestorNetBuy( kiwoomMarketType, this.compactDate( tradeDate ) )
                : Promise.resolve( null ),
            useExternalSources
                ? this.kiwoomRest.getNewHighLowStocks( sectorCode, '1' )
                : Promise.resolve( null ),
            useExternalSources
                ? this.kiwoomRest.getNewHighLowStocks( sectorCode, '2' )
                : Promise.resolve( null ),
        ] );

        let risingCount = stockBreadth.rising_count;
        let flatCount = stockBreadth.flat_count;
        let fallingCount = stockBreadth.falling_count;
        let upperLimitCount = previousSnapshot?.upperLimitCount ?? 0;
        let lowerLimitCount = previousSnapshot?.lowerLimitCount ?? 0;
        let currentVolume = currentIndex.volume;
        if ( sectorResult.status === 'fulfilled' && sectorResult.value ) {
            risingCount = this.parseInteger( sectorResult.value.rising, risingCount );
            flatCount = this.parseInteger( sectorResult.value.stdns, flatCount );
            fallingCount = this.parseInteger( sectorResult.value.fall, fallingCount );
            upperLimitCount = this.parseInteger( sectorResult.value.upl );
            lowerLimitCount = this.parseInteger( sectorResult.value.lst );
            currentVolume = BigInt( this.parseInteger( sectorResult.value.trde_qty, Number( currentVolume ) ) ) * 1000n;
        } else if ( useExternalSources ) {
            sourceErrors.push( '시장 지수/등락 종목 데이터' );
            if ( previousSnapshot ) {
                risingCount = previousSnapshot.risingCount;
                flatCount = previousSnapshot.flatCount;
                fallingCount = previousSnapshot.fallingCount;
            }
        }

        let foreignNetBuy = previousSnapshot ? Number( previousSnapshot.foreignNetBuy ) : 0;
        let institutionNetBuy = previousSnapshot ? Number( previousSnapshot.institutionNetBuy ) : 0;
        let individualNetBuy = previousSnapshot ? Number( previousSnapshot.individualNetBuy ) : 0;
        if ( investorResult.status === 'fulfilled' && investorResult.value ) {
            const target = investorResult.value.inds_netprps?.find( ( row ) =>
                row.inds_cd.startsWith( sectorCode ),
            ) ?? investorResult.value.inds_netprps?.[0];
            if ( target ) {
                foreignNetBuy = this.parseNumber( target.frgnr_netprps );
                institutionNetBuy = this.parseNumber( target.orgn_netprps );
                individualNetBuy = this.parseNumber( target.ind_netprps );
            } else if ( useExternalSources ) {
                sourceErrors.push( '투자자별 순매수 데이터' );
            }
        } else if ( useExternalSources ) {
            sourceErrors.push( '투자자별 순매수 데이터' );
        }

        let newHighCount = stockBreadth.new_high_count;
        let newLowCount = stockBreadth.new_low_count;
        const eligibleCodes = await this.getEligibleStockCodes( marketType );
        if ( highResult.status === 'fulfilled' && highResult.value ) {
            newHighCount = new Set(
                highResult.value.map( ( row ) => row.stk_cd.replace( /^[A-Z]/, '' ) ).filter( ( code ) => eligibleCodes.has( code ) ),
            ).size;
        } else if ( useExternalSources ) {
            sourceErrors.push( '52주 신고가 데이터' );
            if ( previousSnapshot ) newHighCount = previousSnapshot.newHighCount;
        }
        if ( lowResult.status === 'fulfilled' && lowResult.value ) {
            newLowCount = new Set(
                lowResult.value.map( ( row ) => row.stk_cd.replace( /^[A-Z]/, '' ) ).filter( ( code ) => eligibleCodes.has( code ) ),
            ).size;
        } else if ( useExternalSources ) {
            sourceErrors.push( '52주 신저가 데이터' );
            if ( previousSnapshot ) newLowCount = previousSnapshot.newLowCount;
        }

        await this.expireDistributionDays( marketType, indexCandles, tradeDate );
        const previousVolume = previousSnapshot?.volume ?? previousIndex.volume;
        const isDistributionDay =
      indexChangeRate <= this.distributionMinDropRate &&
      currentVolume > previousVolume;

        if ( isDistributionDay ) {
            await this.prisma.marketViewDistributionDay.upsert( {
                where: { marketType_tradeDate: { marketType, tradeDate } },
                create: { marketType, tradeDate, changeRate: indexChangeRate, volume: currentVolume },
                update: {
                    changeRate: indexChangeRate,
                    volume: currentVolume,
                    isActive: true,
                    removedReason: null,
                    removedAt: null,
                },
            } );
        }

        let activeDistributionDays = await this.prisma.marketViewDistributionDay.findMany( {
            where: { marketType, isActive: true, tradeDate: { lte: tradeDate } },
            orderBy: { tradeDate: 'desc' },
        } );
        let distributionCount = activeDistributionDays.length;
        const recentFiveDates = new Set( indexCandles.slice( 0, 5 ).map( ( row ) => this.isoDate( row.candleTime ) ) );
        let distributionAccelerating =
      activeDistributionDays.filter( ( row ) => recentFiveDates.has( this.isoDate( row.tradeDate ) ) ).length >= 3;

        const correction = indexClose < ( ma50 ?? indexClose ) || distributionCount >= 7;
        const rally = this.calculateRallyState( {
            previousSnapshot,
            tradeDate,
            indexLow: Number( currentIndex.lowPrice ) / 100,
            indexChangeRate,
            currentVolume,
            previousVolume,
            correction,
        } );

        if ( rally.isFollowThroughDay ) {
            await this.prisma.marketViewDistributionDay.updateMany( {
                where: { marketType, isActive: true, tradeDate: { lte: tradeDate } },
                data: { isActive: false, removedReason: 'FTD_RESET', removedAt: new Date() },
            } );
            activeDistributionDays = [];
            distributionCount = 0;
            distributionAccelerating = false;
        }

        const longSignal = this.getLongSignal( indexClose, ma50, ma200 );
        const shortSignal = this.getShortSignal( {
            correction,
            distributionCount,
            rallyDay: rally.rallyDay,
            isFollowThroughDay: rally.isFollowThroughDay,
        } );
        const marketState = this.getMarketState( longSignal, shortSignal, rally.rallyDay, rally.isFollowThroughDay );
        const exposure = this.getExposure( shortSignal, marketState );
        const alert = this.getAlert( {
            dataDelayed: sourceErrors.length > 0,
            distributionCount,
            distributionAccelerating,
            rallyDay: rally.rallyDay,
            isFollowThroughDay: rally.isFollowThroughDay,
        } );
        const adr = fallingCount > 0 ? risingCount / fallingCount : null;

        const snapshot = await this.prisma.marketViewDailySnapshot.upsert( {
            where: { marketType_tradeDate: { marketType, tradeDate } },
            create: {
                marketType,
                tradeDate,
                indexOpen: Number( currentIndex.openPrice ) / 100,
                indexHigh: Number( currentIndex.highPrice ) / 100,
                indexLow: Number( currentIndex.lowPrice ) / 100,
                indexClose,
                indexChange,
                indexChangeRate,
                volume: currentVolume,
                risingCount,
                flatCount,
                fallingCount,
                upperLimitCount,
                lowerLimitCount,
                foreignNetBuy,
                institutionNetBuy,
                individualNetBuy,
                ma20,
                ma50,
                ma200,
                belowMa20Ratio: stockBreadth.below_ma20_ratio,
                belowMa200Ratio: stockBreadth.below_ma200_ratio,
                adr,
                newHighCount,
                newLowCount,
                netNewHigh: newHighCount - newLowCount,
                isDistributionDay,
                distributionCount,
                distributionAccelerating,
                rallyDay: rally.rallyDay,
                rallyStartDate: rally.rallyStartDate,
                rallyAttemptLow: rally.rallyAttemptLow,
                isFollowThroughDay: rally.isFollowThroughDay,
                followThroughDate: rally.followThroughDate,
                shortSignal,
                longSignal,
                marketState,
                exposureMin: exposure.min,
                exposureMax: exposure.max,
                alertCode: alert.code,
                alertMessage: alert.message,
                dataStatus: sourceErrors.length > 0 ? 'DELAYED' : 'NORMAL',
                delayedMessage: sourceErrors.length > 0
                    ? `${sourceErrors.join( ', ' )}를 불러오지 못해 계산값 또는 직전 거래일 값을 사용했어요.`
                    : null,
                sourceTradeDate: sourceErrors.length > 0 && previousSnapshot ? previousSnapshot.tradeDate : tradeDate,
            },
            update: {
                indexOpen: Number( currentIndex.openPrice ) / 100,
                indexHigh: Number( currentIndex.highPrice ) / 100,
                indexLow: Number( currentIndex.lowPrice ) / 100,
                indexClose,
                indexChange,
                indexChangeRate,
                volume: currentVolume,
                risingCount,
                flatCount,
                fallingCount,
                upperLimitCount,
                lowerLimitCount,
                foreignNetBuy,
                institutionNetBuy,
                individualNetBuy,
                ma20,
                ma50,
                ma200,
                belowMa20Ratio: stockBreadth.below_ma20_ratio,
                belowMa200Ratio: stockBreadth.below_ma200_ratio,
                adr,
                newHighCount,
                newLowCount,
                netNewHigh: newHighCount - newLowCount,
                isDistributionDay,
                distributionCount,
                distributionAccelerating,
                rallyDay: rally.rallyDay,
                rallyStartDate: rally.rallyStartDate,
                rallyAttemptLow: rally.rallyAttemptLow,
                isFollowThroughDay: rally.isFollowThroughDay,
                followThroughDate: rally.followThroughDate,
                shortSignal,
                longSignal,
                marketState,
                exposureMin: exposure.min,
                exposureMax: exposure.max,
                alertCode: alert.code,
                alertMessage: alert.message,
                dataStatus: sourceErrors.length > 0 ? 'DELAYED' : 'NORMAL',
                delayedMessage: sourceErrors.length > 0
                    ? `${sourceErrors.join( ', ' )}를 불러오지 못해 계산값 또는 직전 거래일 값을 사용했어요.`
                    : null,
                sourceTradeDate: sourceErrors.length > 0 && previousSnapshot ? previousSnapshot.tradeDate : tradeDate,
            },
        } );

        this.logger.log(
            `[market-view] ${marketType} ${this.isoDate( tradeDate )} ${marketState}, distribution=${distributionCount}, rally=${rally.rallyDay ?? '-'}`,
        );
        return this.toMarketResponse( snapshot );
    }

    private calculateRallyState( params: {
    previousSnapshot: any;
    tradeDate: Date;
    indexLow: number;
    indexChangeRate: number;
    currentVolume: bigint;
    previousVolume: bigint;
    correction: boolean;
  } ) {
        const previous = params.previousSnapshot;
        let rallyDay: number | null = null;
        let rallyStartDate: Date | null = null;
        let rallyAttemptLow: number | null = null;

        if ( previous?.rallyDay && previous.rallyAttemptLow != null && !previous.isFollowThroughDay ) {
            const previousLow = Number( previous.rallyAttemptLow );
            if ( params.indexLow < previousLow ) {
                if ( params.indexChangeRate > 0 ) {
                    rallyDay = 1;
                    rallyStartDate = params.tradeDate;
                    rallyAttemptLow = params.indexLow;
                }
            } else {
                rallyDay = previous.rallyDay + 1;
                rallyStartDate = previous.rallyStartDate;
                rallyAttemptLow = previousLow;
            }
        } else if ( params.correction && params.indexChangeRate > 0 ) {
            rallyDay = 1;
            rallyStartDate = params.tradeDate;
            rallyAttemptLow = params.indexLow;
        }

        const isFollowThroughDay =
      rallyDay != null &&
      rallyDay >= 4 &&
      params.indexChangeRate >= this.ftdMinChangeRate &&
      params.currentVolume > params.previousVolume;

        return {
            rallyDay: isFollowThroughDay ? null : rallyDay,
            rallyStartDate: isFollowThroughDay ? null : rallyStartDate,
            rallyAttemptLow: isFollowThroughDay ? null : rallyAttemptLow,
            isFollowThroughDay,
            followThroughDate: isFollowThroughDay ? params.tradeDate : previous?.followThroughDate ?? null,
        };
    }

    private async getStockBreadth( marketType: MarketType, tradeDate: Date ): Promise<StockBreadth> {
        const rows = await this.prisma.$queryRawUnsafe<StockBreadth[]>(
            `
      WITH eligible AS (
        SELECT c.stock_code
        FROM companies c
        WHERE c.deleted_at IS NULL
          AND c.market_type::text = $2
          AND COALESCE(c.trading_state, '') NOT ILIKE '%정지%'
          AND c.company_name !~* '(스팩|SPAC|우$|우B$|우C$)'
      ), base AS (
        SELECT
          sc.stock_code,
          sc.candle_time,
          COALESCE(sc.adj_close_price, sc.close_price)::numeric AS close_price,
          COALESCE(sc.adj_high_price, sc.high_price)::numeric AS high_price,
          COALESCE(sc.adj_low_price, sc.low_price)::numeric AS low_price,
          sc.volume
        FROM stock_candles sc
        JOIN eligible e ON e.stock_code = sc.stock_code
        WHERE sc.candle_type = 'day'
          AND sc.candle_time <= $1::date
          AND sc.candle_time >= $1::date - INTERVAL '450 days'
          AND sc.volume > 0
      ), calculated AS (
        SELECT
          *,
          LAG(close_price) OVER (PARTITION BY stock_code ORDER BY candle_time) AS prev_close,
          AVG(close_price) OVER (
            PARTITION BY stock_code ORDER BY candle_time ROWS BETWEEN 19 PRECEDING AND CURRENT ROW
          ) AS ma20,
          AVG(close_price) OVER (
            PARTITION BY stock_code ORDER BY candle_time ROWS BETWEEN 199 PRECEDING AND CURRENT ROW
          ) AS ma200,
          MAX(high_price) OVER (
            PARTITION BY stock_code ORDER BY candle_time ROWS BETWEEN 249 PRECEDING AND 1 PRECEDING
          ) AS prior_52w_high,
          MIN(low_price) OVER (
            PARTITION BY stock_code ORDER BY candle_time ROWS BETWEEN 249 PRECEDING AND 1 PRECEDING
          ) AS prior_52w_low,
          ROW_NUMBER() OVER (PARTITION BY stock_code ORDER BY candle_time DESC) AS rn
        FROM base
      )
      SELECT
        COUNT(*)::int AS total_count,
        COUNT(*) FILTER (WHERE close_price > prev_close)::int AS rising_count,
        COUNT(*) FILTER (WHERE close_price = prev_close)::int AS flat_count,
        COUNT(*) FILTER (WHERE close_price < prev_close)::int AS falling_count,
        ROUND(100 * COUNT(*) FILTER (WHERE ma20 IS NOT NULL AND close_price < ma20)::numeric
          / NULLIF(COUNT(*) FILTER (WHERE ma20 IS NOT NULL), 0), 2)::float8 AS below_ma20_ratio,
        ROUND(100 * COUNT(*) FILTER (WHERE ma200 IS NOT NULL AND close_price < ma200)::numeric
          / NULLIF(COUNT(*) FILTER (WHERE ma200 IS NOT NULL), 0), 2)::float8 AS below_ma200_ratio,
        COUNT(*) FILTER (WHERE prior_52w_high IS NOT NULL AND high_price >= prior_52w_high)::int AS new_high_count,
        COUNT(*) FILTER (WHERE prior_52w_low IS NOT NULL AND low_price <= prior_52w_low)::int AS new_low_count
      FROM calculated
      WHERE rn = 1
        AND candle_time = $1::date
        AND prev_close IS NOT NULL
      `,
            tradeDate,
            marketType,
        );

        const row = rows[0];
        return {
            total_count: row?.total_count ?? 0,
            rising_count: row?.rising_count ?? 0,
            flat_count: row?.flat_count ?? 0,
            falling_count: row?.falling_count ?? 0,
            below_ma20_ratio: Number( row?.below_ma20_ratio ?? 0 ),
            below_ma200_ratio: Number( row?.below_ma200_ratio ?? 0 ),
            new_high_count: row?.new_high_count ?? 0,
            new_low_count: row?.new_low_count ?? 0,
        };
    }

    private async getEligibleStockCodes( marketType: MarketType ): Promise<Set<string>> {
        const rows = await this.prisma.company.findMany( {
            where: {
                marketType,
                deletedAt: null,
                NOT: [
                    { tradingState: { contains: '정지' } },
                    { companyName: { contains: '스팩', mode: 'insensitive' } },
                ],
            },
            select: { stockCode: true, companyName: true },
        } );
        return new Set(
            rows
                .filter( ( row ) => !/(우|우B|우C)$/i.test( row.companyName ) )
                .map( ( row ) => row.stockCode ),
        );
    }

    private async expireDistributionDays( marketType: MarketType, indexCandles: any[], tradeDate: Date ) {
        const threshold = indexCandles[24]?.candleTime;
        if ( !threshold ) return;
        await this.prisma.marketViewDistributionDay.updateMany( {
            where: {
                marketType,
                isActive: true,
                tradeDate: { lt: threshold, lte: tradeDate },
            },
            data: { isActive: false, removedReason: 'EXPIRED_25D', removedAt: new Date() },
        } );
    }

    private getLongSignal( close: number, ma50: number | null, ma200: number | null ): Signal {
        if ( ma50 == null || ma200 == null ) return 'YELLOW';
        if ( close > ma50 && ma50 > ma200 ) return 'GREEN';
        if ( close > ma200 ) return 'YELLOW';
        return 'RED';
    }

    private getShortSignal( params: {
    correction: boolean;
    distributionCount: number;
    rallyDay: number | null;
    isFollowThroughDay: boolean;
  } ): Signal {
        if ( params.isFollowThroughDay ) return 'GREEN';
        if ( params.rallyDay != null ) return 'YELLOW';
        if ( params.correction || params.distributionCount >= 7 ) return 'RED';
        if ( params.distributionCount >= 5 ) return 'YELLOW';
        return 'GREEN';
    }

    private getMarketState(
        longSignal: Signal,
        shortSignal: Signal,
        rallyDay: number | null,
        isFollowThroughDay: boolean,
    ) {
        if ( isFollowThroughDay && longSignal !== 'RED' ) return '안정적으로 상승 중';
        if ( rallyDay != null ) return '반등 시도 중';
        if ( longSignal === 'GREEN' && shortSignal === 'GREEN' ) return '안정적으로 상승 중';
        if ( longSignal !== 'RED' && shortSignal !== 'RED' ) return '압박받는 상승 중';
        return '조정 중';
    }

    private getExposure( shortSignal: Signal, marketState: string ) {
        if ( marketState === '반등 시도 중' ) return { min: 20, max: 40 };
        if ( shortSignal === 'GREEN' ) return { min: 80, max: 100 };
        if ( shortSignal === 'YELLOW' ) return { min: 40, max: 60 };
        return { min: 0, max: 20 };
    }

    private getAlert( params: {
    dataDelayed: boolean;
    distributionCount: number;
    distributionAccelerating: boolean;
    rallyDay: number | null;
    isFollowThroughDay: boolean;
  } ) {
        if ( params.dataDelayed ) {
            return { code: 'DATA_DELAYED', message: '시장 데이터를 불러오지 못했어요. 마지막 갱신 기준으로 표시 중이에요.' };
        }
        if ( params.distributionCount >= 7 && params.distributionAccelerating ) {
            return { code: 'DISTRIBUTION_7_ACCELERATING', message: '분산일이 7개 쌓인 데다 최근 가속되고 있어요. 즉시 노출을 줄이고 관망하세요.' };
        }
        if ( params.distributionCount >= 7 ) {
            return { code: 'DISTRIBUTION_7', message: '분산일이 7개 누적됐어요. 반등 4일차 이후 팔로우스루 데이 확인 전까지 신규 진입을 미루세요.' };
        }
        if ( params.distributionAccelerating ) {
            return { code: 'DISTRIBUTION_ACCELERATING', message: '최근 분산일이 빠르게 쌓이고 있어요. 단기 변동성이 커질 수 있어요.' };
        }
        if ( params.isFollowThroughDay ) {
            return { code: 'FOLLOW_THROUGH_DAY', message: '새로운 상승장이 확인됐어요. 분산일 카운트가 리셋됐어요.' };
        }
        if ( params.rallyDay != null && params.rallyDay <= 3 ) {
            return { code: 'RALLY_ATTEMPT_EARLY', message: `반등이 시작됐지만 아직 확인되지 않았어요. 현재 반등 ${params.rallyDay}일차예요.` };
        }
        if ( params.rallyDay != null ) {
            return { code: 'RALLY_ATTEMPT_WAITING_FTD', message: '팔로우스루 데이 조건에 근접했어요. 거래량을 동반한 상승이 나오는지 확인하세요.' };
        }
        if ( params.distributionCount >= 5 ) {
            return { code: 'DISTRIBUTION_5_6', message: '추세는 살아있지만 압박받고 있어요. 노출을 40~60%로 줄이는 걸 고려하세요.' };
        }
        if ( params.distributionCount >= 3 ) {
            return { code: 'DISTRIBUTION_3_4', message: '분산일이 쌓이기 시작했어요. 신규 진입 비중은 보수적으로 가져가세요.' };
        }
        return { code: 'NORMAL', message: '추세가 안정적이에요. 현재 노출 비중을 유지해도 돼요.' };
    }

    private buildOverallSignal( markets: any[] ) {
        const byMarket = new Map( markets.map( ( market ) => [ market.marketType, market ] ) );
        const kospi = byMarket.get( 'KOSPI' );
        const kosdaq = byMarket.get( 'KOSDAQ' );
        const shortSignal = this.worstSignal( kospi?.shortSignal, kosdaq?.shortSignal );
        const longSignal = this.worstSignal( kospi?.longSignal, kosdaq?.longSignal );
        const messages: Record<string, { headline: string; guide: string }> = {
            GREEN_GREEN: { headline: '큰 흐름은 살아있어요.', guide: '지금 진입해도 좋아요.' },
            GREEN_YELLOW: { headline: '큰 흐름은 살아있어요.', guide: '신규 진입은 신중하게 접근하세요.' },
            GREEN_RED: { headline: '큰 흐름은 살아있어요.', guide: '지금 당장은 기다리세요.' },
            YELLOW_GREEN: { headline: '추세가 흔들리기 시작했어요.', guide: '지금은 보수적으로 접근하세요.' },
            YELLOW_YELLOW: { headline: '추세도 타이밍도 애매해요.', guide: '관망이 최선이에요.' },
            YELLOW_RED: { headline: '추세가 무너지고 있어요.', guide: '지금은 빠져나올 때예요.' },
            RED_GREEN: { headline: '큰 흐름이 무너졌어요.', guide: '단기 반등에 속지 마세요.' },
            RED_YELLOW: { headline: '약세장 속 잠깐 숨 고르는 중이에요.', guide: '비중을 더 줄이세요.' },
            RED_RED: { headline: '시장 전체가 위험해요.', guide: '현금 비중을 높이세요.' },
        };
        const message = messages[`${longSignal}_${shortSignal}`];
        return {
            shortSignal,
            longSignal,
            signalMeta: {
                short: this.getSignalMeta( shortSignal ),
                long: this.getSignalMeta( longSignal ),
            },
            headline: message.headline,
            guide: message.guide,
            summary: [ kospi, kosdaq ]
                .filter( Boolean )
                .map( ( market ) => `${market.marketType} ${market.alertMessage}` )
                .join( ' ' ),
        };
    }

    private worstSignal( ...signals: Array<Signal | undefined> ): Signal {
        const weight: Record<Signal, number> = { GREEN: 0, YELLOW: 1, RED: 2 };
        return signals.filter( Boolean ).sort( ( a, b ) => weight[b!] - weight[a!] )[0] ?? 'YELLOW';
    }

    private async toMarketResponse( row: any ) {
        const latestDistributionDays = await this.prisma.marketViewDistributionDay.findMany( {
            where: { marketType: row.marketType, isActive: true, tradeDate: { lte: row.tradeDate } },
            orderBy: { tradeDate: 'desc' },
            take: 3,
        } );
        return {
            marketType: row.marketType,
            tradeDate: this.isoDate( row.tradeDate ),
            index: {
                open: Number( row.indexOpen ),
                high: Number( row.indexHigh ),
                low: Number( row.indexLow ),
                close: Number( row.indexClose ),
                change: Number( row.indexChange ),
                changeRate: Number( row.indexChangeRate ),
                volume: row.volume.toString(),
            },
            breadth: {
                risingCount: row.risingCount,
                flatCount: row.flatCount,
                fallingCount: row.fallingCount,
                upperLimitCount: row.upperLimitCount,
                lowerLimitCount: row.lowerLimitCount,
                adr: row.adr == null ? null : Number( row.adr ),
                adrStatus: this.getAdrStatus( row.adr == null ? null : Number( row.adr ) ),
            },
            investorFlow: {
                foreign: Number( row.foreignNetBuy ),
                institution: Number( row.institutionNetBuy ),
                individual: Number( row.individualNetBuy ),
                unit: '억원',
            },
            movingAverages: {
                ma20: row.ma20 == null ? null : Number( row.ma20 ),
                ma50: row.ma50 == null ? null : Number( row.ma50 ),
                ma200: row.ma200 == null ? null : Number( row.ma200 ),
                belowMa20Ratio: Number( row.belowMa20Ratio ),
                belowMa200Ratio: Number( row.belowMa200Ratio ),
                belowMa20Status: this.getMaBreakdownStatus( Number( row.belowMa20Ratio ) ),
                belowMa200Status: this.getMaBreakdownStatus( Number( row.belowMa200Ratio ) ),
            },
            newHighLow: {
                newHighCount: row.newHighCount,
                newLowCount: row.newLowCount,
                net: row.netNewHigh,
                status: this.getSignedStatus( row.netNewHigh ),
            },
            distribution: {
                isDistributionDay: row.isDistributionDay,
                count: row.distributionCount,
                accelerating: row.distributionAccelerating,
                latestDays: latestDistributionDays.map( ( day ) => ( {
                    tradeDate: this.isoDate( day.tradeDate ),
                    changeRate: Number( day.changeRate ),
                    volume: day.volume.toString(),
                } ) ),
            },
            rally: {
                day: row.rallyDay,
                startDate: row.rallyStartDate ? this.isoDate( row.rallyStartDate ) : null,
                isFollowThroughDay: row.isFollowThroughDay,
                followThroughDate: row.followThroughDate ? this.isoDate( row.followThroughDate ) : null,
            },
            shortSignal: row.shortSignal,
            longSignal: row.longSignal,
            signalMeta: {
                short: this.getSignalMeta( row.shortSignal ),
                long: this.getSignalMeta( row.longSignal ),
            },
            marketState: row.marketState,
            recommendedExposure: { min: row.exposureMin, max: row.exposureMax },
            alertCode: row.alertCode,
            alertMessage: row.alertMessage,
            dataStatus: row.dataStatus,
            delayedMessage: row.delayedMessage,
            sourceTradeDate: this.isoDate( row.sourceTradeDate ),
            updatedAt: row.updatedAt,
        };
    }

    private getMaBreakdownStatus( ratio: number ) {
        if ( ratio < 20 ) return this.withSignalMeta( 'GREEN', '이탈 종목 적음' );
        if ( ratio < 40 ) return this.withSignalMeta( 'YELLOW', '이탈 종목 보통' );
        return this.withSignalMeta( 'RED', '이탈 종목 많음' );
    }

    private getAdrStatus( adr: number | null ) {
        if ( adr == null ) return this.withSignalMeta( 'YELLOW', '비교 데이터 없음' );
        if ( adr > 1 ) return this.withSignalMeta( 'GREEN', '상승 종목 우세' );
        if ( adr < 1 ) return this.withSignalMeta( 'RED', '하락 종목 우세' );
        return this.withSignalMeta( 'YELLOW', '상승·하락 동수' );
    }

    private getSignedStatus( value: number ) {
        if ( value > 0 ) return this.withSignalMeta( 'GREEN', '신고가 우세' );
        if ( value < 0 ) return this.withSignalMeta( 'RED', '신저가 우세' );
        return this.withSignalMeta( 'YELLOW', '신고가·신저가 동수' );
    }

    private withSignalMeta<T extends string>( signal: Signal, label: T ) {
        return {
            signal,
            label,
            signalMeta: this.getSignalMeta( signal ),
        };
    }

    private getSignalMeta( signal: Signal ): SignalMeta {
        const meta: Record<Signal, SignalMeta> = {
            GREEN: {
                action: 'BUY',
                actionLabel: '매수',
                signalLabel: '상승신호',
                colorClass: 'rose-500',
                inactiveColorClass: 'rose-200',
            },
            RED: {
                action: 'SELL',
                actionLabel: '매도',
                signalLabel: '하락신호',
                colorClass: 'blue-500',
                inactiveColorClass: 'blue-200',
            },
            YELLOW: {
                action: 'NEUTRAL',
                actionLabel: '중립',
                signalLabel: '중립',
                colorClass: 'slate-500',
                inactiveColorClass: 'slate-200',
            },
        };
        return meta[signal];
    }

    private async getLatestCommonIndexDate(): Promise<Date> {
        const [ kospi, kosdaq ] = await Promise.all( [
            this.prisma.stockCandle.findFirst( {
                where: { stockCode: 'INDEX_KOSPI', candleType: 'day' },
                orderBy: { candleTime: 'desc' },
                select: { candleTime: true },
            } ),
            this.prisma.stockCandle.findFirst( {
                where: { stockCode: 'INDEX_KOSDAQ', candleType: 'day' },
                orderBy: { candleTime: 'desc' },
                select: { candleTime: true },
            } ),
        ] );
        if ( !kospi || !kosdaq ) throw new NotFoundException( 'KOSPI/KOSDAQ 지수 일봉이 없습니다' );
        return kospi.candleTime < kosdaq.candleTime ? kospi.candleTime : kosdaq.candleTime;
    }

    private averageLast( values: number[], count: number ): number | null {
        if ( values.length < count ) return null;
        const target = values.slice( -count );
        return target.reduce( ( sum, value ) => sum + value, 0 ) / target.length;
    }

    private parseNumber( value: string | number | null | undefined ): number {
        if ( value == null ) return 0;
        const parsed = Number( String( value ).replace( /[,+]/g, '' ) );
        return Number.isFinite( parsed ) ? parsed : 0;
    }

    private parseInteger( value: string | number | null | undefined, fallback = 0 ): number {
        if ( value == null || String( value ).trim() === '' ) return fallback;
        const parsed = Math.trunc( Number( String( value ).replace( /[,+]/g, '' ) ) );
        return Number.isFinite( parsed ) ? parsed : fallback;
    }

    private async yieldToEventLoop() {
        await new Promise<void>( ( resolve ) => setTimeout( resolve, 50 ) );
    }

    private dateOnly( date: Date ): Date {
        return new Date( Date.UTC( date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() ) );
    }

    private isoDate( date: Date ): string {
        return date.toISOString().slice( 0, 10 );
    }

    private compactDate( date: Date ): string {
        return this.isoDate( date ).replace( /-/g, '' );
    }
}
