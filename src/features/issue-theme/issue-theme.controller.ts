import { Controller, Get, Post, Delete, Param, Query, ParseIntPipe, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiParam, ApiQuery } from '@nestjs/swagger';
import { IssueThemeService } from './issue-theme.service';
import { Public } from '../../common/auth/decorators/public.decorator';
import { OptionalJwtAuthGuard } from '../../common/auth/guards/optional-jwt-auth.guard';
import { CurrentUser } from '../../common/auth/decorators/current-user.decorator';

@ApiTags( '이슈테마 (Issue Theme)' )
@Controller('issue-theme')
export class IssueThemeController {
  constructor(private readonly issueThemeService: IssueThemeService) {}

  @Get()
  @Public()
  @ApiOperation( { summary: '이슈테마 목록 조회', description: '상승 종목 비율 내림차순. 실시간 차트 필터 통과 종목 기준.' } )
  @ApiQuery( { name: 'display', required: false, example: '20', description: '페이지당 항목 수' } )
  @ApiQuery( { name: 'page', required: false, example: '1', description: '페이지 번호' } )
  async getThemeList(
    @Query('display') display: string = '20',
    @Query('page') page: string = '1',
  ) {
    return this.issueThemeService.getThemeList(Number(display), Number(page));
  }

  @Get(':themeCode')
  @Public()
  @UseGuards(OptionalJwtAuthGuard)
  @ApiOperation( { summary: '테마 상세 조회', description: '기본정보, 인사이트 문구, 종목 테이블. 로그인 시 isFavorite 반환.' } )
  @ApiParam( { name: 'themeCode', example: 101, description: '테마코드' } )
  async getThemeDetail(
    @Param('themeCode', ParseIntPipe) themeCode: number,
    @CurrentUser('userId') userId: string | undefined,
  ) {
    return this.issueThemeService.getThemeDetail(themeCode, userId);
  }

  @Post(':themeCode/favorite')
  @ApiBearerAuth( 'access-token' )
  @ApiOperation( { summary: '테마 즐겨찾기 추가 (로그인 필요)' } )
  @ApiParam( { name: 'themeCode', example: 101, description: '테마코드' } )
  async addFavorite(
    @Param('themeCode', ParseIntPipe) themeCode: number,
    @CurrentUser('userId') userId: string,
  ) {
    return this.issueThemeService.addFavorite(userId, themeCode);
  }

  @Delete(':themeCode/favorite')
  @ApiBearerAuth( 'access-token' )
  @ApiOperation( { summary: '테마 즐겨찾기 삭제 (로그인 필요)' } )
  @ApiParam( { name: 'themeCode', example: 101, description: '테마코드' } )
  async removeFavorite(
    @Param('themeCode', ParseIntPipe) themeCode: number,
    @CurrentUser('userId') userId: string,
  ) {
    return this.issueThemeService.removeFavorite(userId, themeCode);
  }

  @Post('sync-themes')
  @Public()
  @ApiOperation( { summary: '[관리자] 테마 동기화', description: '키움 API upName → themes 테이블 + company.theme_code 동기화 (최초 1회)' } )
  async syncThemes() {
    return this.issueThemeService.syncThemes();
  }

  @Post('snapshot/theme')
  @Public()
  @ApiOperation( { summary: '[관리자] 테마 일별 스냅샷 저장', description: '장 마감 후 1회 실행' } )
  async saveThemeSnapshot() {
    return this.issueThemeService.saveThemeSnapshot();
  }

  @Post('snapshot/theme/backfill')
  @Public()
  @ApiOperation( { summary: '[관리자] 테마 일별 스냅샷 백필', description: 'stock_daily_metrics 기준으로 최근 N거래일 테마 순위를 재계산합니다.' } )
  @ApiQuery( { name: 'days', required: false, example: '60', description: '백필할 최근 거래일 수' } )
  async backfillThemeSnapshots(@Query('days') days: string = '60') {
    return this.issueThemeService.backfillThemeSnapshots(Number(days));
  }

  @Post('snapshot/trading-value')
  @Public()
  @ApiOperation( { summary: '[관리자] 거래대금 스냅샷 저장', description: '10분 단위 실행' } )
  async saveTradingValueSnapshot() {
    return this.issueThemeService.saveTradingValueSnapshot();
  }
}
