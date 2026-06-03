import { Body, Controller, Get, Post, Delete, Param, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiParam, ApiQuery } from '@nestjs/swagger';
import { IssueThemeService } from './issue-theme.service';
import { Public } from '../../common/auth/decorators/public.decorator';
import { OptionalJwtAuthGuard } from '../../common/auth/guards/optional-jwt-auth.guard';
import { AdminApiKeyGuard } from '../../common/auth/guards/admin-api-key.guard';
import { CurrentUser } from '../../common/auth/decorators/current-user.decorator';
import { IntRangePipe } from '../../common/pipes/input-validation.pipes';

@ApiTags( '이슈테마 (Issue Theme)' )
@Controller('issue-theme')
export class IssueThemeController {
  constructor(private readonly issueThemeService: IssueThemeService) {}

  @Get()
  @Public()
  @ApiOperation( { summary: '이슈테마 목록 조회', description: '상승 종목 비율 내림차순. 실시간 차트 필터 통과 종목 기준.' } )
  @ApiQuery( { name: 'display', required: false, example: '20', description: '페이지당 항목 수' } )
  @ApiQuery( { name: 'page', required: false, example: '1', description: '페이지 번호' } )
  @ApiQuery( { name: 'minAvgRsScore', required: false, example: '80', description: '테마 평균 RS 점수 최소값' } )
  @ApiQuery( { name: 'minTotalCount', required: false, example: '3', description: '집계 대상 종목 최소 개수' } )
  @ApiQuery( { name: 'minThemeScore', required: false, example: '70', description: '테마 종합 점수 최소값' } )
  async getThemeList(
    @Query('display', new IntRangePipe('display', 1, 100, true)) display: number = 20,
    @Query('page', new IntRangePipe('page', 1, 10000, true)) page: number = 1,
    @Query('minAvgRsScore', new IntRangePipe('minAvgRsScore', 0, 100, true)) minAvgRsScore?: number,
    @Query('minTotalCount', new IntRangePipe('minTotalCount', 1, 1000, true)) minTotalCount?: number,
    @Query('minThemeScore', new IntRangePipe('minThemeScore', 0, 100, true)) minThemeScore?: number,
  ) {
    return this.issueThemeService.getThemeList(display, page, { minAvgRsScore, minTotalCount, minThemeScore });
  }

  @Get('admin/themes')
  @Public()
  @UseGuards(AdminApiKeyGuard)
  @ApiOperation( { summary: '[Admin] Theme code map' } )
  async adminListThemes(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('search') search?: string,
    @Query('source') source?: string,
    @Query('includeDeleted') includeDeleted?: string,
  ) {
    return this.issueThemeService.adminListThemes({
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
      search,
      source,
      includeDeleted: includeDeleted === 'true',
    });
  }

  @Get(':themeCode')
  @Public()
  @UseGuards(OptionalJwtAuthGuard)
  @ApiOperation( { summary: '테마 상세 조회', description: '기본정보, 인사이트 문구, 종목 테이블. 로그인 시 isFavorite 반환.' } )
  @ApiParam( { name: 'themeCode', example: 101, description: '테마코드' } )
  async getThemeDetail(
    @Param('themeCode', new IntRangePipe('themeCode', 1, 999999)) themeCode: number,
    @CurrentUser('userId') userId: string | undefined,
  ) {
    return this.issueThemeService.getThemeDetail(themeCode, userId);
  }

  @Post(':themeCode/favorite')
  @ApiBearerAuth( 'access-token' )
  @ApiOperation( { summary: '테마 즐겨찾기 추가 (로그인 필요)' } )
  @ApiParam( { name: 'themeCode', example: 101, description: '테마코드' } )
  async addFavorite(
    @Param('themeCode', new IntRangePipe('themeCode', 1, 999999)) themeCode: number,
    @CurrentUser('userId') userId: string,
  ) {
    return this.issueThemeService.addFavorite(userId, themeCode);
  }

  @Delete(':themeCode/favorite')
  @ApiBearerAuth( 'access-token' )
  @ApiOperation( { summary: '테마 즐겨찾기 삭제 (로그인 필요)' } )
  @ApiParam( { name: 'themeCode', example: 101, description: '테마코드' } )
  async removeFavorite(
    @Param('themeCode', new IntRangePipe('themeCode', 1, 999999)) themeCode: number,
    @CurrentUser('userId') userId: string,
  ) {
    return this.issueThemeService.removeFavorite(userId, themeCode);
  }

  @Post('sync-themes')
  @Public()
  @UseGuards(AdminApiKeyGuard)
  @ApiOperation( { summary: '[관리자] 테마 동기화', description: '키움 API upName → themes 테이블 + company.theme_code 동기화 (최초 1회)' } )
  async syncThemes() {
    return this.issueThemeService.syncThemes();
  }

  @Post('sync-naver-themes')
  @Public()
  @UseGuards(AdminApiKeyGuard)
  @ApiOperation( { summary: '[관리자] 네이버 테마 동기화', description: 'naver_themes_full.json 기반으로 themes + stock_themes를 동기화합니다.' } )
  async syncNaverThemes(@Body('filePath') filePath?: string) {
    return this.issueThemeService.syncNaverThemes(filePath);
  }

  @Post('sync-grouped-themes')
  @Public()
  @UseGuards(AdminApiKeyGuard)
  @ApiOperation( { summary: '[Admin] Grouped theme sync', description: 'grouping_theme.json 기반으로 GROUP source 테마 코드를 DB에 동기화합니다.' } )
  async syncGroupedThemes(@Body('filePath') filePath?: string) {
    return this.issueThemeService.syncGroupedThemes(filePath);
  }

  @Post('snapshot/theme')
  @Public()
  @UseGuards(AdminApiKeyGuard)
  @ApiOperation( { summary: '[관리자] 테마 일별 스냅샷 저장', description: '장 마감 후 1회 실행' } )
  async saveThemeSnapshot() {
    return this.issueThemeService.saveThemeSnapshot();
  }

  @Post('snapshot/theme/backfill')
  @Public()
  @UseGuards(AdminApiKeyGuard)
  @ApiOperation( { summary: '[관리자] 테마 일별 스냅샷 백필', description: 'stock_daily_metrics 기준으로 최근 N거래일 테마 순위를 재계산합니다.' } )
  @ApiQuery( { name: 'days', required: false, example: '60', description: '백필할 최근 거래일 수' } )
  async backfillThemeSnapshots(@Query('days', new IntRangePipe('days', 1, 365, true)) days: number = 60) {
    return this.issueThemeService.backfillThemeSnapshots(days);
  }

  @Post('snapshot/trading-value')
  @Public()
  @UseGuards(AdminApiKeyGuard)
  @ApiOperation( { summary: '[관리자] 거래대금 스냅샷 저장', description: '10분 단위 실행' } )
  async saveTradingValueSnapshot() {
    return this.issueThemeService.saveTradingValueSnapshot();
  }
}
