import { Controller, Get, Post, Param, Query, DefaultValuePipe, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiParam, ApiQuery, ApiOkResponse } from '@nestjs/swagger';
import { StockInfoService } from './stock-info.service';
import { Public } from '../../common/auth/decorators/public.decorator';
import { AdminApiKeyGuard } from '../../common/auth/guards/admin-api-key.guard';
import { StockNewsResponseDto } from './dto/news-response.dto';
import { EnumPipe, IntRangePipe, RegexPipe, StockCodePipe } from '../../common/pipes/input-validation.pipes';

@ApiTags( '종목정보 (Stock Info)' )
@Controller('stock-info')
@Public()
export class StockInfoController {
  constructor(private readonly stockInfoService: StockInfoService) {}

  @Post('sync-corp-codes')
  @UseGuards(AdminApiKeyGuard)
  @ApiOperation( { summary: '[관리자] DART 고유번호 전체 동기화', description: '최초 1회 또는 주기적 실행' } )
  async syncCorpCodes() {
    return await this.stockInfoService.syncCorpCodes();
  }

  @Get(':stockCode/overview')
  @ApiOperation( { summary: '기업개황 조회', description: '업종, 설립일, 결산월, 대표자, 주소 등' } )
  @ApiParam( { name: 'stockCode', example: '005930', description: '종목코드' } )
  async getOverview(@Param('stockCode', new StockCodePipe()) stockCode: string) {
    return await this.stockInfoService.getCompanyOverview(stockCode);
  }

  @Get(':stockCode/income')
  @ApiOperation( { summary: '손익현황 조회', description: '매출액, 영업이익, 순이익 (당기/전기/전전기)' } )
  @ApiParam( { name: 'stockCode', example: '005930', description: '종목코드' } )
  @ApiQuery( { name: 'year', required: false, example: '2024', description: '기준연도 (생략 시 최근)' } )
  async getIncome(
    @Param('stockCode', new StockCodePipe()) stockCode: string,
    @Query('year', new RegexPipe(/^\d{4}$/, 'year', true)) year?: string,
  ) {
    return await this.stockInfoService.getIncomeStatement(stockCode, year);
  }

  @Get(':stockCode/cash-flow')
  @ApiOperation( { summary: '현금흐름현황 조회', description: '영업/투자/재무 현금흐름' } )
  @ApiParam( { name: 'stockCode', example: '005930', description: '종목코드' } )
  @ApiQuery( { name: 'year', required: false, example: '2024', description: '기준연도 (생략 시 최근)' } )
  async getCashFlow(
    @Param('stockCode', new StockCodePipe()) stockCode: string,
    @Query('year', new RegexPipe(/^\d{4}$/, 'year', true)) year?: string,
  ) {
    return await this.stockInfoService.getCashFlow(stockCode, year);
  }

  @Get(':stockCode/indicators')
  @ApiOperation( { summary: '재무지표 조회', description: '수익성, 안정성, 활동성 지표' } )
  @ApiParam( { name: 'stockCode', example: '005930', description: '종목코드' } )
  @ApiQuery( { name: 'year', required: false, example: '2024', description: '기준연도 (생략 시 최근)' } )
  async getIndicators(
    @Param('stockCode', new StockCodePipe()) stockCode: string,
    @Query('year', new RegexPipe(/^\d{4}$/, 'year', true)) year?: string,
  ) {
    return await this.stockInfoService.getFinancialIndicators(stockCode, year);
  }

  @Get(':stockCode/news')
  @ApiOperation( { summary: '종목 뉴스 조회', description: '네이버 뉴스 검색 (종목명 기준)' } )
  @ApiParam( { name: 'stockCode', example: '005930', description: '종목코드' } )
  @ApiQuery( { name: 'display', required: false, example: 10, description: '결과 수 (기본 10)' } )
  @ApiQuery( { name: 'sort', required: false, enum: ['date', 'sim'], description: '정렬 (date: 최신순, sim: 관련도순)' } )
  @ApiQuery( { name: 'start', required: false, example: 1, description: '시작 위치 (기본 1)' } )
  @ApiOkResponse( { type: StockNewsResponseDto } )
  async getNews(
    @Param('stockCode', new StockCodePipe()) stockCode: string,
    @Query('display', new DefaultValuePipe(10), new IntRangePipe('display', 1, 100)) display: number,
    @Query('sort', new EnumPipe(['date', 'sim'] as const, 'sort', true)) sort: 'date' | 'sim' = 'date',
    @Query('start', new DefaultValuePipe(1), new IntRangePipe('start', 1, 1000)) start: number,
  ) {
    return await this.stockInfoService.searchNews(stockCode, display, sort, start);
  }

  @Get(':stockCode/stockInfo')
  @ApiOperation( { summary: '종목정보 탭 통합 조회', description: '기업개황 + 손익 + 현금흐름 + 재무지표 한 번에 조회' } )
  @ApiParam( { name: 'stockCode', example: '005930', description: '종목코드' } )
  @ApiQuery( { name: 'year', required: false, example: '2024', description: '기준연도 (생략 시 최근)' } )
  async getSummary(
    @Param('stockCode', new StockCodePipe()) stockCode: string,
    @Query('year', new RegexPipe(/^\d{4}$/, 'year', true)) year?: string,
  ) {
    return await this.stockInfoService.getStockInfoSummary(stockCode, year);
  }

  @Post('sync-listed-shares')
  @UseGuards(AdminApiKeyGuard)
  @ApiOperation( { summary: '[관리자] 상장주식수 동기화', description: 'stockCode 지정 시 단건, 없으면 전체 종목' } )
  @ApiQuery( { name: 'stockCode', required: false, example: '005930', description: '종목코드 (생략 시 전체)' } )
  async syncListedShares(@Query('stockCode', new StockCodePipe(true)) stockCode?: string) {
    return await this.stockInfoService.syncListedShares(stockCode);
  }

  @Get('debug-dart/:stockCode')
  @ApiOperation( { summary: '[디버그] DART list.json 직접 조회' } )
  @ApiParam( { name: 'stockCode', example: '005930', description: '종목코드' } )
  async debugDart(@Param('stockCode', new StockCodePipe()) stockCode: string) {
    return await this.stockInfoService.debugDartList(stockCode);
  }

  @Post('sync-business-info')
  @UseGuards(AdminApiKeyGuard)
  @ApiOperation( { summary: '[관리자] 주요사업 정보 동기화', description: 'DART 사업보고서 → Company.businessInfo JSONB. stockCode 지정 시 단건.' } )
  @ApiQuery( { name: 'stockCode', required: false, example: '005930', description: '종목코드 (생략 시 전체)' } )
  async syncBusinessInfo(@Query('stockCode', new StockCodePipe(true)) stockCode?: string) {
    return await this.stockInfoService.syncBusinessInfo(stockCode);
  }
}
