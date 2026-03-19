import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';

@Injectable()
export class WatchlistService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 관심종목 현황 조회
   * 최신 거래일 지표 + 전일 대비 순위 변동 + 이벤트 계산
   */
  async getWatchlistStocks(userId: string) {
    const watchlist = await this.prisma.userWatchlist.findMany({
      where: { userId, deletedAt: null },
      include: {
        company: {
          select: { companyId: true, companyName: true, stockCode: true, marketType: true },
        },
      },
      orderBy: { addedDate: 'desc' },
    });

    if (watchlist.length === 0) return { tradeDate: null, stocks: [] };

    const stockCodes = watchlist.map((w) => w.company.stockCode);

    // 최신 거래일 조회
    const latestMetric = await this.prisma.stockDailyMetrics.findFirst({
      where: { stockCode: { in: stockCodes } },
      orderBy: { tradeDate: 'desc' },
      select: { tradeDate: true },
    });

    if (!latestMetric) {
      return {
        tradeDate: null,
        stocks: watchlist.map((w) => this.buildStockItem(w, null, null)),
      };
    }

    const latestDate = latestMetric.tradeDate;

    // 당일 + 전일 지표 병렬 조회
    const prevDateRecord = await this.prisma.stockDailyMetrics.findFirst({
      where: { tradeDate: { lt: latestDate } },
      orderBy: { tradeDate: 'desc' },
      select: { tradeDate: true },
    });

    const [todayMetrics, prevMetrics] = await Promise.all([
      this.prisma.stockDailyMetrics.findMany({
        where: { stockCode: { in: stockCodes }, tradeDate: latestDate },
      }),
      prevDateRecord
        ? this.prisma.stockDailyMetrics.findMany({
            where: { stockCode: { in: stockCodes }, tradeDate: prevDateRecord.tradeDate },
          })
        : Promise.resolve([]),
    ]);

    const todayMap = new Map(todayMetrics.map((m) => [m.stockCode, m]));
    const prevMap = new Map(prevMetrics.map((m) => [m.stockCode, m]));

    return {
      tradeDate: latestDate,
      stocks: watchlist.map((w) =>
        this.buildStockItem(w, todayMap.get(w.company.stockCode) ?? null, prevMap.get(w.company.stockCode) ?? null),
      ),
    };
  }

  private buildStockItem(watchlistEntry: any, today: any, prev: any) {
    const events: string[] = [];

    if (today) {
      if (today.isNewHigh) events.push('NEW_HIGH');
      if (prev) {
        if (today.rank < prev.rank) events.push('RANK_UP');
        else if (today.rank > prev.rank) events.push('RANK_DOWN');
      }
    }

    return {
      companyId: watchlistEntry.companyId,
      stockCode: watchlistEntry.company.stockCode,
      companyName: watchlistEntry.company.companyName,
      marketType: watchlistEntry.company.marketType,
      addedDate: watchlistEntry.addedDate,
      memo: watchlistEntry.memo ?? null,
      closePrice: today ? Number(today.closePrice) : null,
      priceChange1d: today?.priceChange1d != null ? Number(today.priceChange1d) : null,
      priceChangeRate1d: today?.priceChangeRate1d != null ? Number(today.priceChangeRate1d) : null,
      rank: today?.rank ?? null,
      prevRank: prev?.rank ?? null,
      relativeStrengthScore: today ? Number(today.relativeStrengthScore) : null,
      isNewHigh: today?.isNewHigh ?? false,
      events,
    };
  }

  /**
   * 관심종목 추가 (stockCode 기반)
   */
  async addStock(userId: string, stockCode: string) {
    const company = await this.prisma.company.findFirst({
      where: { stockCode, deletedAt: null },
    });
    if (!company) throw new NotFoundException(`종목코드 ${stockCode}를 찾을 수 없습니다`);

    const existing = await this.prisma.userWatchlist.findFirst({
      where: { userId, companyId: company.companyId, deletedAt: null },
    });
    if (existing) throw new ConflictException(`이미 관심종목으로 등록된 종목입니다`);

    // soft delete된 항목이 있으면 복구, 없으면 새로 생성
    const deleted = await this.prisma.userWatchlist.findFirst({
      where: { userId, companyId: company.companyId, deletedAt: { not: null } },
    });

    if (deleted) {
      return this.prisma.userWatchlist.update({
        where: { userId_companyId: { userId, companyId: company.companyId } },
        data: { deletedAt: null, addedDate: new Date() },
        include: { company: { select: { companyName: true, stockCode: true, marketType: true } } },
      });
    }

    return this.prisma.userWatchlist.create({
      data: { userId, companyId: company.companyId },
      include: { company: { select: { companyName: true, stockCode: true, marketType: true } } },
    });
  }

  /**
   * 관심종목 삭제 (stockCode 기반, soft delete)
   */
  async removeStock(userId: string, stockCode: string) {
    const company = await this.prisma.company.findFirst({
      where: { stockCode, deletedAt: null },
    });
    if (!company) throw new NotFoundException(`종목코드 ${stockCode}를 찾을 수 없습니다`);

    const watchlistEntry = await this.prisma.userWatchlist.findFirst({
      where: { userId, companyId: company.companyId, deletedAt: null },
    });
    if (!watchlistEntry) throw new NotFoundException(`관심종목에 등록되지 않은 종목입니다`);

    await this.prisma.userWatchlist.update({
      where: { userId_companyId: { userId, companyId: company.companyId } },
      data: { deletedAt: new Date() },
    });

    return { message: '관심종목에서 삭제되었습니다', stockCode };
  }
}
