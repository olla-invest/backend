import { Controller, Get, Post, Delete, Param, Body } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiParam, ApiBody } from '@nestjs/swagger';
import { WatchlistService } from './watchlist.service';
import { CurrentUser } from '../../common/auth/decorators/current-user.decorator';
import { IntRangePipe, StockCodePipe } from '../../common/pipes/input-validation.pipes';

@ApiTags( '관심종목/테마 (Watchlist)' )
@ApiBearerAuth( 'access-token' )
@Controller('watchlist')
export class WatchlistController {
  constructor(private readonly watchlistService: WatchlistService) {}

  // ─── 관심종목 ────────────────────────────────────────────────────

  @Get('stocks')
  @ApiOperation( { summary: '관심종목 현황 조회' } )
  async getWatchlistStocks(@CurrentUser('userId') userId: string) {
    return this.watchlistService.getWatchlistStocks(userId);
  }

  @Post('stocks')
  @ApiOperation( { summary: '관심종목 추가' } )
  @ApiBody( { schema: { example: { stockCode: '005930' } } } )
  async addStock(
    @CurrentUser('userId') userId: string,
    @Body('stockCode', new StockCodePipe()) stockCode: string,
  ) {
    return this.watchlistService.addStock(userId, stockCode);
  }

  @Delete('stocks/:stockCode')
  @ApiOperation( { summary: '관심종목 삭제' } )
  @ApiParam( { name: 'stockCode', example: '005930', description: '종목코드' } )
  async removeStock(
    @CurrentUser('userId') userId: string,
    @Param('stockCode', new StockCodePipe()) stockCode: string,
  ) {
    return this.watchlistService.removeStock(userId, stockCode);
  }

  // ─── 관심테마 ────────────────────────────────────────────────────

  @Get('themes')
  @ApiOperation( { summary: '관심테마 현황 조회 (이벤트 포함, 가나다순)' } )
  async getWatchlistThemes(@CurrentUser('userId') userId: string) {
    return this.watchlistService.getWatchlistThemes(userId);
  }

  @Post('themes')
  @ApiOperation( { summary: '관심테마 추가' } )
  @ApiBody( { schema: { example: { themeCode: 101 } } } )
  async addTheme(
    @CurrentUser('userId') userId: string,
    @Body('themeCode', new IntRangePipe('themeCode', 1, 999999)) themeCode: number,
  ) {
    return this.watchlistService.addTheme(userId, themeCode);
  }

  @Delete('themes/:themeCode')
  @ApiOperation( { summary: '관심테마 삭제' } )
  @ApiParam( { name: 'themeCode', example: 101, description: '테마코드' } )
  async removeTheme(
    @CurrentUser('userId') userId: string,
    @Param('themeCode', new IntRangePipe('themeCode', 1, 999999)) themeCode: number,
  ) {
    return this.watchlistService.removeTheme(userId, themeCode);
  }

  // ─── 내 관심 페이지 ──────────────────────────────────────────────

  @Get('highlights')
  @ApiOperation( { summary: '오늘 주목해야 할 내 관심항목 Top5 (테마2+종목3)' } )
  async getHighlights(@CurrentUser('userId') userId: string) {
    return this.watchlistService.getHighlights(userId);
  }

  @Get('recommendations')
  @ApiOperation( { summary: '함께 보면 좋을 만한 종목·테마 추천' } )
  async getRecommendations(@CurrentUser('userId') userId: string) {
    return this.watchlistService.getRecommendations(userId);
  }

  @Get('my')
  @ApiOperation( { summary: '내 관심 통합 목록 (테마+종목, addedDate 내림차순)' } )
  async getMyWatchlist(@CurrentUser('userId') userId: string) {
    return this.watchlistService.getMyWatchlist(userId);
  }
}
