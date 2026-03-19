import { Controller, Get, Post, Delete, Param, Body } from '@nestjs/common';
import { WatchlistService } from './watchlist.service';
import { CurrentUser } from '../../common/auth/decorators/current-user.decorator';

@Controller('watchlist')
export class WatchlistController {
  constructor(private readonly watchlistService: WatchlistService) {}

  /**
   * GET /watchlist/stocks
   * 관심종목 현황 조회
   * - 최신 거래일 기준 지표 (종가, 등락률, RS점수, 순위)
   * - 전일 대비 순위 변동
   * - 이벤트: NEW_HIGH(신고가), RANK_UP(순위상승), RANK_DOWN(순위하락)
   */
  @Get('stocks')
  async getWatchlistStocks(@CurrentUser('userId') userId: string) {
    return this.watchlistService.getWatchlistStocks(userId);
  }

  /**
   * POST /watchlist/stocks
   * 관심종목 추가
   * Body: { "stockCode": "005930" }
   */
  @Post('stocks')
  async addStock(
    @CurrentUser('userId') userId: string,
    @Body('stockCode') stockCode: string,
  ) {
    return this.watchlistService.addStock(userId, stockCode);
  }

  /**
   * DELETE /watchlist/stocks/:stockCode
   * 관심종목 삭제
   */
  @Delete('stocks/:stockCode')
  async removeStock(
    @CurrentUser('userId') userId: string,
    @Param('stockCode') stockCode: string,
  ) {
    return this.watchlistService.removeStock(userId, stockCode);
  }
}
