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

    it( 'uses the worse KOSPI/KOSDAQ signal for the headline', () => {
        const overall = service.buildOverallSignal( [
            { marketType: 'KOSPI', shortSignal: 'GREEN', longSignal: 'GREEN', alertMessage: '정상' },
            { marketType: 'KOSDAQ', shortSignal: 'RED', longSignal: 'YELLOW', alertMessage: '경고' },
        ] );

        expect( overall.shortSignal ).toBe( 'RED' );
        expect( overall.longSignal ).toBe( 'YELLOW' );
        expect( overall.signalMeta.short ).toMatchObject( {
            actionLabel: '매도',
            signalLabel: '하락신호',
            colorClass: 'blue-500',
            inactiveColorClass: 'blue-200',
        } );
        expect( overall.signalMeta.long ).toMatchObject( {
            actionLabel: '중립',
            signalLabel: '중립',
            colorClass: 'slate-500',
            inactiveColorClass: 'slate-200',
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
            actionLabel: '매수',
            signalLabel: '상승신호',
            colorClass: 'rose-500',
            inactiveColorClass: 'rose-200',
        } );
    } );
} );
