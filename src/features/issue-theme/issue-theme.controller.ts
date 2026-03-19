import { Controller, Get, Post, Param, Query, ParseIntPipe } from '@nestjs/common';
import { IssueThemeService } from './issue-theme.service';
import { Public } from '../../common/auth/decorators/public.decorator';

@Controller('issue-theme')
@Public()
export class IssueThemeController {
  constructor(private readonly issueThemeService: IssueThemeService) {}

  /**
   * GET /issue-theme
   * 이슈테마 목록 조회
   * - 상승 종목 비율 내림차순 순위
   * - 실시간 차트 필터 통과 종목 기준
   */
  @Get()
  async getThemeList(
    @Query('display') display: string = '20',
    @Query('page') page: string = '1',
  ) {
    return this.issueThemeService.getThemeList(Number(display), Number(page));
  }

  /**
   * GET /issue-theme/:themeCode
   * 테마 팝업 상세 조회
   * - 기본정보 (순위/순위변동/상승종목 수)
   * - 인사이트 문구
   * - 종목 테이블 (RS점수 내림차순)
   */
  @Get(':themeCode')
  async getThemeDetail(@Param('themeCode', ParseIntPipe) themeCode: number) {
    return this.issueThemeService.getThemeDetail(themeCode);
  }

  /**
   * POST /issue-theme/snapshot/theme
   * 테마 일별 스냅샷 저장 (장 마감 후 1회)
   */
  @Post('snapshot/theme')
  async saveThemeSnapshot() {
    return this.issueThemeService.saveThemeSnapshot();
  }

  /**
   * POST /issue-theme/snapshot/trading-value
   * 거래대금 스냅샷 저장 (10분 단위)
   */
  @Post('snapshot/trading-value')
  async saveTradingValueSnapshot() {
    return this.issueThemeService.saveTradingValueSnapshot();
  }
}
