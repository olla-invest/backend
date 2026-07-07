import { Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Public } from '../../common/auth/decorators/public.decorator';
import { AdminApiKeyGuard } from '../../common/auth/guards/admin-api-key.guard';
import { IntRangePipe } from '../../common/pipes/input-validation.pipes';
import { MarketViewService } from './market-view.service';

@ApiTags( '마켓뷰 (Market View)' )
@Controller( 'market-view' )
export class MarketViewController {
    constructor( private readonly marketViewService: MarketViewService ) {}

  @Get()
  @Public()
  @ApiOperation( { summary: '최신 마켓뷰 조회' } )
    getLatest() {
        return this.marketViewService.getLatest();
    }

  @Get( 'markets/:marketType/distribution-days' )
  @Public()
  @ApiOperation( { summary: '시장별 분산일 목록 조회' } )
  @ApiParam( { name: 'marketType', enum: [ 'KOSPI', 'KOSDAQ' ] } )
  @ApiQuery( { name: 'limit', required: false, example: 25 } )
  getDistributionDays(
    @Param( 'marketType' ) marketType: 'KOSPI' | 'KOSDAQ',
    @Query( 'limit', new IntRangePipe( 'limit', 1, 100, true ) ) limit = 25,
  ) {
      return this.marketViewService.getDistributionDays( marketType, limit );
  }

  @Get( 'markets/:marketType/index-candles' )
  @Public()
  @ApiOperation( { summary: '시장별 지수 장중 그래프 데이터 조회' } )
  @ApiParam( { name: 'marketType', enum: [ 'KOSPI', 'KOSDAQ' ] } )
  @ApiQuery( { name: 'tradeDate', required: false, example: '2026-07-03' } )
  getIndexCandles(
    @Param( 'marketType' ) marketType: 'KOSPI' | 'KOSDAQ',
    @Query( 'tradeDate' ) tradeDate?: string,
  ) {
      return this.marketViewService.getIndexCandles(
          marketType,
          tradeDate ? new Date( `${tradeDate}T00:00:00.000Z` ) : undefined,
      );
  }

  @Post( 'admin/recalculate' )
  @Public()
  @UseGuards( AdminApiKeyGuard )
  @ApiOperation( { summary: '[관리자] 최신 거래일 마켓뷰 재계산' } )
  recalculate() {
      return this.marketViewService.calculateLatest();
  }

  @Post( 'admin/backfill' )
  @Public()
  @UseGuards( AdminApiKeyGuard )
  @ApiOperation( { summary: '[관리자] 최근 N거래일 마켓뷰 백필' } )
  @ApiQuery( { name: 'days', required: false, example: 260 } )
  backfill(
    @Query( 'days', new IntRangePipe( 'days', 2, 1500, true ) ) days = 260,
  ) {
      return this.marketViewService.backfill( days );
  }
}
