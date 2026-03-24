import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RealtimePriceCacheService } from '../real-time-chart/realtime-price-cache.service';
import { KiwoomRestService } from '../../integrations/kiwoom/rest/kiwoom-rest.service';

@Injectable()
export class IssueThemeService {
  private readonly logger = new Logger(IssueThemeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtimeCache: RealtimePriceCacheService,
    private readonly kiwoomRest: KiwoomRestService,
  ) {}

  // ─── 헬퍼 ────────────────────────────────────────────────────────

  /** UTC 기준 KST 시각 반환 */
  private getKstNow(): Date {
    return new Date(Date.now() + 9 * 60 * 60 * 1000);
  }

  /** 현재 KST 시각을 10분 단위로 내린 HHmm 문자열 (ex: "1030") */
  private getCurrentSnapshotTime(): string {
    const kst = this.getKstNow();
    const hh = String(kst.getUTCHours()).padStart(2, '0');
    const mm = String(Math.floor(kst.getUTCMinutes() / 10) * 10).padStart(2, '0');
    return `${hh}${mm}`;
  }

  /** metrics에 DF 필터(DF1/DF2/DF3) 적용 */
  private applyDynamicFilter(metrics: any[]): any[] {
    return metrics.filter((m) => {
      const cp = Number(m.closePrice);
      const df1 = m.lowPrice52w != null && cp >= Number(m.lowPrice52w) * 1.3;
      const df2 = m.highPrice52w != null && cp >= Number(m.highPrice52w) * 0.75;
      const df3 = m.ma50 != null && cp > Number(m.ma50);
      return df1 && df2 && df3;
    });
  }

  // ─── 공통 데이터 로더 ─────────────────────────────────────────────

  /** 최신 거래일 기준 필터 통과 종목 조회 */
  private async getFilteredMetrics() {
    const latest = await this.prisma.stockDailyMetrics.findFirst({
      orderBy: { tradeDate: 'desc' },
      select: { tradeDate: true },
    });
    if (!latest) return { tradeDate: null, metrics: [] };

    const sfMetrics = await this.prisma.stockDailyMetrics.findMany({
      where: { tradeDate: latest.tradeDate, passedStaticFilters: true },
    });
    return { tradeDate: latest.tradeDate, metrics: this.applyDynamicFilter(sfMetrics) };
  }

  // ─── 이슈테마 목록 ────────────────────────────────────────────────

  async getThemeList(display: number = 20, page: number = 1) {
    const { tradeDate, metrics } = await this.getFilteredMetrics();
    if (!tradeDate) return { updatedAt: null, total: 0, page, display, themes: [] };

    const stockCodes = metrics.map((m) => m.stockCode);

    // 종목 → themeCode 매핑
    const companies = await this.prisma.company.findMany({
      where: { stockCode: { in: stockCodes }, themeCode: { not: null }, deletedAt: null },
      select: { stockCode: true, themeCode: true },
    });
    const themeCodeMap = new Map<string, number>(
      companies.filter((c) => c.themeCode != null).map((c) => [c.stockCode, c.themeCode!]),
    );

    // 실시간 등락률
    const prices = this.realtimeCache.getPrices(stockCodes);

    // 테마별 그룹핑
    const themeGroups = new Map<number, { changeRates: number[] }>();
    for (const m of metrics) {
      const themeCode = themeCodeMap.get(m.stockCode);
      if (themeCode == null) continue;
      if (!themeGroups.has(themeCode)) themeGroups.set(themeCode, { changeRates: [] });
      const rt = prices.get(m.stockCode);
      const changeRate = rt ? rt.changeRate : (m.priceChangeRate1d ? Number(m.priceChangeRate1d) : 0);
      themeGroups.get(themeCode)!.changeRates.push(changeRate);
    }

    // 테마명 조회
    const themeCodes = Array.from(themeGroups.keys());
    const themes = await this.prisma.theme.findMany({
      where: { themeCode: { in: themeCodes }, deletedAt: null },
      select: { themeCode: true, themeName: true },
    });
    const themeNameMap = new Map(themes.map((t) => [t.themeCode, t.themeName]));

    // 전일 순위 스냅샷
    const prevSnapshots = await this.prisma.themeDailySnapshot.findMany({
      where: { themeCode: { in: themeCodes }, snapshotDate: { lt: tradeDate } },
      orderBy: { snapshotDate: 'desc' },
      distinct: ['themeCode'],
    });
    const prevRankMap = new Map(prevSnapshots.map((s) => [s.themeCode, s.rank]));

    // 상승비율 계산
    const themeList: any[] = [];
    for (const [themeCode, { changeRates }] of themeGroups) {
      const totalCount = changeRates.length;
      const risingCount = changeRates.filter((r) => r > 0).length;
      const risingRatio = totalCount > 0 ? (risingCount / totalCount) * 100 : 0;
      const avgChangeRate = changeRates.reduce((a, b) => a + b, 0) / (changeRates.length || 1);
      themeList.push({ themeCode, themeName: themeNameMap.get(themeCode) ?? '알 수 없음', totalCount, risingCount, risingRatio: Math.round(risingRatio * 100) / 100, avgChangeRate: Math.round(avgChangeRate * 100) / 100 });
    }

    // 순위 산출 (상승비율 내림차순, 동률 동일순위)
    themeList.sort((a, b) => b.risingRatio - a.risingRatio);
    let rank = 1;
    for (let i = 0; i < themeList.length; i++) {
      if (i > 0 && themeList[i].risingRatio === themeList[i - 1].risingRatio) {
        themeList[i].rank = themeList[i - 1].rank;
      } else {
        themeList[i].rank = rank;
      }
      rank++;
    }

    // 순위변동
    for (const t of themeList) {
      const prevRank = prevRankMap.get(t.themeCode);
      t.rankChange = prevRank != null ? prevRank - t.rank : null;
    }

    const total = themeList.length;
    const paged = themeList.slice((page - 1) * display, page * display);

    return { updatedAt: new Date().toISOString(), total, page, display, themes: paged };
  }

  // ─── 테마 상세 (팝업) ─────────────────────────────────────────────

  async getThemeDetail(themeCode: number) {
    const theme = await this.prisma.theme.findFirst({ where: { themeCode, deletedAt: null } });
    if (!theme) throw new NotFoundException(`Theme ${themeCode} not found`);

    const { tradeDate, metrics: allMetrics } = await this.getFilteredMetrics();
    if (!tradeDate) return null;

    // 테마 내 종목만 필터
    const companies = await this.prisma.company.findMany({
      where: { themeCode, deletedAt: null },
      select: { stockCode: true, companyName: true },
    });
    const themeStockCodes = new Set(companies.map((c) => c.stockCode));
    const companyNameMap = new Map(companies.map((c) => [c.stockCode, c.companyName]));

    const metrics = allMetrics.filter((m) => themeStockCodes.has(m.stockCode));
    const filteredCodes = metrics.map((m) => m.stockCode);
    const metricsMap = new Map(metrics.map((m) => [m.stockCode, m]));

    // 실시간 가격
    const prices = this.realtimeCache.getPrices(filteredCodes);

    // 전일 동시간 거래대금 스냅샷
    const snapshotTime = this.getCurrentSnapshotTime();
    const kstToday = this.getKstNow();
    const todayDate = new Date(Date.UTC(kstToday.getUTCFullYear(), kstToday.getUTCMonth(), kstToday.getUTCDate()));
    const yesterdayDate = new Date(todayDate);
    yesterdayDate.setUTCDate(yesterdayDate.getUTCDate() - 1);

    const prevSnapshots = await this.prisma.stockTradingValueSnapshot.findMany({
      where: { stockCode: { in: filteredCodes }, snapshotDate: yesterdayDate, snapshotTime },
    });
    const prevTradingMap = new Map(prevSnapshots.map((s) => [s.stockCode, Number(s.accTradingValue)]));

    // 등락률/거래대금 집계
    const changeRates: number[] = [];
    let highVolumeCount = 0;

    const stockRows = filteredCodes.map((code) => {
      const m = metricsMap.get(code)!;
      const rt = prices.get(code);
      const changeRate = rt ? rt.changeRate : (m.priceChangeRate1d ? Number(m.priceChangeRate1d) : 0);
      const currentPrice = rt ? rt.currentPrice : Number(m.closePrice);
      const accAmount = rt ? rt.accAmount : 0;

      changeRates.push(changeRate);

      // 거래대금 변화 배율
      const prevAcc = prevTradingMap.get(code);
      let tradingValueRatio: string = '-';
      if (prevAcc != null && prevAcc > 1_000_000) {
        const ratio = accAmount / prevAcc;
        tradingValueRatio = `${Math.round(ratio * 10) / 10}배`;
        if (ratio >= 2.0) highVolumeCount++;
      }

      return {
        stockCode: code,
        companyName: companyNameMap.get(code) ?? '',
        currentPrice,
        changeRate,
        rsScore: Number(m.relativeStrengthScore),
        tradingValueRatio,
      };
    });

    // RS점수 내림차순 정렬 후 순위 부여
    stockRows.sort((a, b) => b.rsScore - a.rsScore);
    stockRows.forEach((r: any, i) => { r.rank = i + 1; });

    // 인사이트 계산
    const totalCount = filteredCodes.length;
    const risingCount = changeRates.filter((r) => r > 0).length;
    const risingRatio = totalCount > 0 ? (risingCount / totalCount) * 100 : 0;
    const avgChangeRate = changeRates.reduce((a, b) => a + b, 0) / (changeRates.length || 1);

    const prevSnapshot = await this.prisma.themeDailySnapshot.findFirst({
      where: { themeCode, snapshotDate: { lt: tradeDate } },
      orderBy: { snapshotDate: 'desc' },
    });

    const insights: string[] = [];
    if (prevSnapshot) {
      if (risingRatio - Number(prevSnapshot.risingRatio) >= 10 && risingRatio >= 50) {
        insights.push('테마 내 상승 종목 비율 증가');
      }
      if (highVolumeCount - prevSnapshot.highVolumeCount >= 2) {
        insights.push('거래대금 급증 종목 증가');
      }
    }
    if (avgChangeRate >= 2) insights.push('평균 등락률 상승');
    if (changeRates.some((r) => r >= 7)) insights.push('상위 종목 급등');

    // 순위/순위변동
    const currentSnapshot = await this.prisma.themeDailySnapshot.findFirst({
      where: { themeCode, snapshotDate: tradeDate },
    });
    const rankChange =
      currentSnapshot && prevSnapshot ? prevSnapshot.rank - currentSnapshot.rank : null;

    return {
      themeCode,
      themeName: theme.themeName,
      rank: currentSnapshot?.rank ?? null,
      rankChange,
      risingCount,
      totalCount,
      insights,
      stocks: stockRows,
      updatedAt: new Date().toISOString(),
    };
  }

  // ─── 스냅샷 저장 ──────────────────────────────────────────────────

  /** 테마 일별 스냅샷 저장 (장 마감 후 1회 호출) */
  async saveThemeSnapshot() {
    const { tradeDate, metrics } = await this.getFilteredMetrics();
    if (!tradeDate) return { saved: 0 };

    const stockCodes = metrics.map((m) => m.stockCode);
    const companies = await this.prisma.company.findMany({
      where: { stockCode: { in: stockCodes }, themeCode: { not: null }, deletedAt: null },
      select: { stockCode: true, themeCode: true },
    });
    const themeCodeMap = new Map(
      companies.filter((c) => c.themeCode != null).map((c) => [c.stockCode, c.themeCode!]),
    );

    const prices = this.realtimeCache.getPrices(stockCodes);
    const themeGroups = new Map<number, { changeRates: number[] }>();

    for (const m of metrics) {
      const themeCode = themeCodeMap.get(m.stockCode);
      if (themeCode == null) continue;
      if (!themeGroups.has(themeCode)) themeGroups.set(themeCode, { changeRates: [] });
      const rt = prices.get(m.stockCode);
      const changeRate = rt ? rt.changeRate : (m.priceChangeRate1d ? Number(m.priceChangeRate1d) : 0);
      themeGroups.get(themeCode)!.changeRates.push(changeRate);
    }

    // 순위 산출
    const themeList: any[] = [];
    for (const [themeCode, { changeRates }] of themeGroups) {
      const totalCount = changeRates.length;
      const risingCount = changeRates.filter((r) => r > 0).length;
      const risingRatio = totalCount > 0 ? (risingCount / totalCount) * 100 : 0;
      const avgChangeRate = changeRates.reduce((a, b) => a + b, 0) / (changeRates.length || 1);
      themeList.push({ themeCode, totalCount, risingCount, risingRatio, avgChangeRate });
    }

    themeList.sort((a, b) => b.risingRatio - a.risingRatio);
    let rank = 1;
    for (let i = 0; i < themeList.length; i++) {
      if (i > 0 && themeList[i].risingRatio === themeList[i - 1].risingRatio) {
        themeList[i].rank = themeList[i - 1].rank;
      } else {
        themeList[i].rank = rank;
      }
      rank++;
    }

    const snapshotDate = new Date(Date.UTC(
      (tradeDate as Date).getUTCFullYear(),
      (tradeDate as Date).getUTCMonth(),
      (tradeDate as Date).getUTCDate(),
    ));

    await this.prisma.themeDailySnapshot.createMany({
      data: themeList.map((t) => ({
        themeCode: t.themeCode,
        snapshotDate,
        rank: t.rank,
        risingCount: t.risingCount,
        totalCount: t.totalCount,
        risingRatio: t.risingRatio,
        avgChangeRate: t.avgChangeRate,
        highVolumeCount: 0,
      })),
      skipDuplicates: true,
    });

    this.logger.log(`Theme snapshot saved: ${themeList.length} themes for ${snapshotDate.toISOString().split('T')[0]}`);
    return { saved: themeList.length, date: snapshotDate.toISOString().split('T')[0] };
  }

  /** 거래대금 스냅샷 저장 (10분 단위 호출) */
  async saveTradingValueSnapshot() {
    const snapshotTime = this.getCurrentSnapshotTime();
    const kstNow = this.getKstNow();
    const snapshotDate = new Date(Date.UTC(
      kstNow.getUTCFullYear(),
      kstNow.getUTCMonth(),
      kstNow.getUTCDate(),
    ));

    const allPrices = this.realtimeCache.getAllPrices();
    const snapshots: any[] = [];

    for (const [stockCode, price] of allPrices) {
      if (price.accAmount > 0) {
        snapshots.push({
          stockCode,
          snapshotDate,
          snapshotTime,
          accTradingValue: BigInt(Math.round(price.accAmount)),
        });
      }
    }

    if (snapshots.length === 0) return { saved: 0, time: snapshotTime };

    await this.prisma.stockTradingValueSnapshot.createMany({
      data: snapshots,
      skipDuplicates: true,
    });

    this.logger.log(`Trading value snapshot saved: ${snapshots.length} stocks at ${snapshotTime}`);
    return { saved: snapshots.length, time: snapshotTime };
  }

  // ─── 테마 동기화 ──────────────────────────────────────────────────

  /**
   * 키움 API 종목 리스트의 upName → themes 테이블 + company.theme_code 동기화
   * 최초 1회 또는 테마 데이터 갱신 시 수동 호출
   */
  async syncThemes(): Promise<{ themesCreated: number; companiesUpdated: number }> {
    this.logger.log('Starting theme sync from Kiwoom stock list...');

    // KOSPI + KOSDAQ 종목 리스트 조회 (upName 포함)
    const [kospiResult, kosdaqResult] = await Promise.all([
      this.kiwoomRest.getStockList('0'),
      this.kiwoomRest.getStockList('10'),
    ]);
    const allStocks = [
      ...kospiResult.list.filter((s) => s.code?.match(/^\d{6}$/)),
      ...kosdaqResult.list.filter((s) => s.code?.match(/^\d{6}$/)),
    ];
    this.logger.log(`Fetched ${allStocks.length} stocks from Kiwoom`);

    // 기존 테마 조회
    const existingThemes = await this.prisma.theme.findMany({ where: { deletedAt: null } });
    const themeNameToCode = new Map<string, number>(existingThemes.map((t) => [t.themeName, t.themeCode]));
    const maxCode = existingThemes.reduce((max, t) => Math.max(max, t.themeCode), 0);
    let nextCode = maxCode + 1;

    // 신규 upName → theme 생성
    const newThemes: { themeCode: number; themeName: string }[] = [];
    for (const stock of allStocks) {
      if (!stock.upName || themeNameToCode.has(stock.upName)) continue;
      themeNameToCode.set(stock.upName, nextCode);
      newThemes.push({ themeCode: nextCode, themeName: stock.upName });
      nextCode++;
    }

    if (newThemes.length > 0) {
      await this.prisma.theme.createMany({ data: newThemes, skipDuplicates: true });
      this.logger.log(`Created ${newThemes.length} new themes`);
    }

    // company.theme_code 업데이트 (배치)
    let companiesUpdated = 0;
    for (const stock of allStocks) {
      if (!stock.upName) continue;
      const themeCode = themeNameToCode.get(stock.upName);
      if (!themeCode) continue;
      const result = await this.prisma.company.updateMany({
        where: { stockCode: stock.code, deletedAt: null },
        data: { themeCode },
      });
      companiesUpdated += result.count;
    }

    this.logger.log(`Theme sync done: ${newThemes.length} themes created, ${companiesUpdated} companies updated`);
    return { themesCreated: newThemes.length, companiesUpdated };
  }
}
