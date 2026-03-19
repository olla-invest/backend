import { Controller, Get, Post, Param, Query, ParseIntPipe, DefaultValuePipe } from '@nestjs/common';
import { StockInfoService } from './stock-info.service';
import { Public } from '../../common/auth/decorators/public.decorator';

@Controller('stock-info')
@Public()
export class StockInfoController {
  constructor(private readonly stockInfoService: StockInfoService) {}

  /**
   * POST /stock-info/sync-corp-codes
   * DART 고유번호 전체 동기화 (최초 1회 또는 주기적 실행)
   */
  @Post('sync-corp-codes')
  async syncCorpCodes() {
    return await this.stockInfoService.syncCorpCodes();
  }

  /**
   * GET /stock-info/:stockCode/overview
   * 기업개황 (업종, 설립일, 결산월, 대표자, 주소 등)
   */
  @Get(':stockCode/overview')
  async getOverview(@Param('stockCode') stockCode: string) {
    return await this.stockInfoService.getCompanyOverview(stockCode);
  }

  /**
   * GET /stock-info/:stockCode/income?year=2024
   * 손익현황 (매출액, 영업이익, 순이익 - 당기/전기/전전기)
   */
  @Get(':stockCode/income')
  async getIncome(
    @Param('stockCode') stockCode: string,
    @Query('year') year?: string,
  ) {
    return await this.stockInfoService.getIncomeStatement(stockCode, year);
  }

  /**
   * GET /stock-info/:stockCode/cash-flow?year=2024
   * 현금흐름현황 (영업/투자/재무)
   */
  @Get(':stockCode/cash-flow')
  async getCashFlow(
    @Param('stockCode') stockCode: string,
    @Query('year') year?: string,
  ) {
    return await this.stockInfoService.getCashFlow(stockCode, year);
  }

  /**
   * GET /stock-info/:stockCode/indicators?year=2024
   * 재무지표 (수익성, 안정성, 활동성)
   */
  @Get(':stockCode/indicators')
  async getIndicators(
    @Param('stockCode') stockCode: string,
    @Query('year') year?: string,
  ) {
    return await this.stockInfoService.getFinancialIndicators(stockCode, year);
  }

  /**
   * GET /stock-info/:stockCode/news?display=10&sort=date
   * 네이버 뉴스 검색 (종목명 기준)
   */
  @Get(':stockCode/news')
  async getNews(
    @Param('stockCode') stockCode: string,
    @Query('display', new DefaultValuePipe(10), ParseIntPipe) display: number,
    @Query('sort') sort: 'date' | 'sim' = 'date',
    @Query('start', new DefaultValuePipe(1), ParseIntPipe) start: number,
  ) {
    return await this.stockInfoService.searchNews(stockCode, display, sort, start);
  }

  /**
   * GET /stock-info/:stockCode/stockInfo?year=2024
   * 종목정보 탭 통합 조회 (기업개황 + 손익 + 현금흐름 + 재무지표)
   */
  @Get(':stockCode/stockInfo')
  async getSummary(
    @Param('stockCode') stockCode: string,
    @Query('year') year?: string,
  ) {
    return await this.stockInfoService.getStockInfoSummary(stockCode, year);
  }
}
