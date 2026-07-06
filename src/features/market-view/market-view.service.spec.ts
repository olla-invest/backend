import { MarketViewService } from './market-view.service';

describe( 'MarketViewService rules', () => {
    const service = new MarketViewService( {} as any, {} as any, {} as any ) as any;

    describe( 'follow-through day', () => {
        it( 'marks day 4 with at least 1.7% gain and higher volume as FTD', () => {
            const result = service.calculateRallyState( {
                previousSnapshot: {
                    rallyDay: 3,
                    rallyStartDate: new Date( '2026-06-18T00:00:00.000Z' ),
                    rallyAttemptLow: 2500,
                    isFollowThroughDay: false,
                    followThroughDate: null,
                },
                tradeDate: new Date( '2026-06-23T00:00:00.000Z' ),
                indexLow: 2520,
                indexChangeRate: 1.7,
                currentVolume: 1200n,
                previousVolume: 1000n,
                correction: true,
            } );

            expect( result.isFollowThroughDay ).toBe( true );
            expect( result.rallyDay ).toBeNull();
            expect( result.followThroughDate ).toEqual( new Date( '2026-06-23T00:00:00.000Z' ) );
        } );

        it( 'does not mark FTD when volume is not higher', () => {
            const result = service.calculateRallyState( {
                previousSnapshot: {
                    rallyDay: 3,
                    rallyStartDate: new Date( '2026-06-18T00:00:00.000Z' ),
                    rallyAttemptLow: 2500,
                    isFollowThroughDay: false,
                },
                tradeDate: new Date( '2026-06-23T00:00:00.000Z' ),
                indexLow: 2520,
                indexChangeRate: 2,
                currentVolume: 1000n,
                previousVolume: 1000n,
                correction: true,
            } );

            expect( result.isFollowThroughDay ).toBe( false );
            expect( result.rallyDay ).toBe( 4 );
        } );

        it( 'restarts rally attempt when the day-1 low is undercut', () => {
            const result = service.calculateRallyState( {
                previousSnapshot: {
                    rallyDay: 2,
                    rallyStartDate: new Date( '2026-06-19T00:00:00.000Z' ),
                    rallyAttemptLow: 2500,
                    isFollowThroughDay: false,
                },
                tradeDate: new Date( '2026-06-23T00:00:00.000Z' ),
                indexLow: 2490,
                indexChangeRate: 0.5,
                currentVolume: 1000n,
                previousVolume: 900n,
                correction: true,
            } );

            expect( result.rallyDay ).toBe( 1 );
            expect( result.rallyAttemptLow ).toBe( 2490 );
        } );
    } );

    describe( 'distribution day volume rules', () => {
        it( 'keeps sector volume in the same unit as stored index candles', () => {
            expect( service.getComparableMarketVolume( '554574', 560644n ) ).toBe( 554574n );
            expect( service.getComparableMarketVolume( undefined, 560644n ) ).toBe( 560644n );
        } );

        it( 'does not mark a distribution day when volume decreases', () => {
            expect( service.isDistributionDay( -6.7391, 554574n, 601212n ) ).toBe( false );
            expect( service.isDistributionDay( -6.7391, 601213n, 601212n ) ).toBe( true );
        } );

        it( 'deactivates an existing distribution day when recalculation no longer qualifies', async () => {
            const prisma = {
                marketViewDistributionDay: {
                    updateMany: jest.fn().mockResolvedValue( { count: 1 } ),
                },
            };
            const recalculatingService = new MarketViewService( prisma as any, {} as any, {} as any ) as any;
            const tradeDate = new Date( '2026-07-02T00:00:00.000Z' );

            await recalculatingService.syncDistributionDay( 'KOSDAQ', tradeDate, false, -6.7391, 554574n );

            expect( prisma.marketViewDistributionDay.updateMany ).toHaveBeenCalledWith( {
                where: { marketType: 'KOSDAQ', tradeDate, isActive: true },
                data: {
                    isActive: false,
                    removedReason: 'RECALCULATED_NOT_DISTRIBUTION',
                    removedAt: expect.any( Date ),
                },
            } );
        } );
    } );

    describe( 'index chart candles', () => {
        it( 'returns KOSPI/KOSDAQ index day candles for chart rendering', async () => {
            const prisma = {
                stockCandle: {
                    findMany: jest.fn().mockResolvedValue( [
                        {
                            candleTime: new Date( '2026-07-02T00:00:00.000Z' ),
                            openPrice: 90453,
                            highPrice: 90453,
                            lowPrice: 86374,
                            closePrice: 86672,
                            volume: 560644n,
                        },
                        {
                            candleTime: new Date( '2026-07-01T00:00:00.000Z' ),
                            openPrice: 92409,
                            highPrice: 95545,
                            lowPrice: 90587,
                            closePrice: 92935,
                            volume: 601212n,
                        },
                    ] ),
                },
            };
            const chartService = new MarketViewService( prisma as any, {} as any, {} as any ) as any;

            const result = await chartService.getIndexCandles( 'KOSDAQ', 2 );

            expect( prisma.stockCandle.findMany ).toHaveBeenCalledWith( {
                where: { stockCode: 'INDEX_KOSDAQ', candleType: 'day' },
                orderBy: { candleTime: 'desc' },
                take: 2,
            } );
            expect( result ).toEqual( {
                marketType: 'KOSDAQ',
                stockCode: 'INDEX_KOSDAQ',
                period: 'day',
                limit: 2,
                items: [
                    {
                        tradeDate: '2026-07-01',
                        open: 924.09,
                        high: 955.45,
                        low: 905.87,
                        close: 929.35,
                        change: null,
                        changeRate: null,
                        volume: '601212',
                    },
                    {
                        tradeDate: '2026-07-02',
                        open: 904.53,
                        high: 904.53,
                        low: 863.74,
                        close: 866.72,
                        change: -62.63,
                        changeRate: -6.7391,
                        volume: '560644',
                    },
                ],
            } );
        } );

        it( 'returns both index chart series for the market view response', async () => {
            const chartService = new MarketViewService( {} as any, {} as any, {} as any ) as any;
            chartService.getIndexCandles = jest
                .fn()
                .mockResolvedValueOnce( { items: [ { tradeDate: '2026-07-03', close: 8088.34 } ] } )
                .mockResolvedValueOnce( { items: [ { tradeDate: '2026-07-03', close: 868.41 } ] } );

            const result = await chartService.getIndexChartSeries( 60 );

            expect( chartService.getIndexCandles ).toHaveBeenNthCalledWith( 1, 'KOSPI', 60 );
            expect( chartService.getIndexCandles ).toHaveBeenNthCalledWith( 2, 'KOSDAQ', 60 );
            expect( result ).toEqual( {
                kospi: [ { tradeDate: '2026-07-03', close: 8088.34 } ],
                kosdaq: [ { tradeDate: '2026-07-03', close: 868.41 } ],
            } );
        } );
    } );

    it( 'uses the worse KOSPI/KOSDAQ signal for the headline', () => {
        const overall = service.buildOverallSignal( [
            { marketType: 'KOSPI', shortSignal: 'GREEN', longSignal: 'GREEN', alertMessage: '정상' },
            { marketType: 'KOSDAQ', shortSignal: 'RED', longSignal: 'YELLOW', alertMessage: '경고' },
        ] );

        expect( overall.shortSignal ).toBe( 'RED' );
        expect( overall.longSignal ).toBe( 'YELLOW' );
        expect( overall.signalMeta.short ).toMatchObject( {
            action: 'RED',
            actionLabel: '위험',
            signalLabel: '매도 또는 대기',
            colorClass: 'blue',
            inactiveColorClass: 'blue',
        } );
        expect( overall.signalMeta.long ).toMatchObject( {
            action: 'YELLOW',
            actionLabel: '중립',
            signalLabel: '주의',
            colorClass: 'slate',
            inactiveColorClass: 'slate',
        } );
        expect( overall.guide ).toBe( '지금은 빠져나올 때예요.' );
    } );

    it( 'requires both long and short green signals for stable rise', () => {
        expect( service.getMarketState( 'GREEN', 'GREEN', null, false ) ).toBe( '안정적으로 상승 중' );
        expect( service.getMarketState( 'YELLOW', 'GREEN', null, false ) ).toBe( '압박받는 상승 중' );
        expect( service.getMarketState( 'RED', 'GREEN', null, false ) ).toBe( '조정 중' );
    } );

    it( 'classifies market breadth indicators for the frontend', () => {
        expect( service.getMaBreakdownStatus( 19.9 ).signal ).toBe( 'GREEN' );
        expect( service.getMaBreakdownStatus( 20 ).signal ).toBe( 'YELLOW' );
        expect( service.getMaBreakdownStatus( 40 ).signal ).toBe( 'RED' );
        expect( service.getAdrStatus( 1.1 ).signal ).toBe( 'GREEN' );
        expect( service.getSignedStatus( -1 ).signal ).toBe( 'RED' );
        expect( service.getAdrStatus( 1.1 ).signalMeta ).toMatchObject( {
            action: 'GREEN',
            actionLabel: '긍정',
            signalLabel: '진입 가능',
            colorClass: 'rose',
            inactiveColorClass: 'rose',
        } );
    } );
} );
