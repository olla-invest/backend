import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { LLM_CLIENT, LlmClient, ThemeSummaryArticle } from './llm/llm-client.interface';
import { ThemeNewsService } from './theme-news.service';

@Injectable()
export class ThemeAiSummaryService {
  private readonly logger = new Logger(ThemeAiSummaryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly news: ThemeNewsService,
    @Inject(LLM_CLIENT) private readonly llm: LlmClient,
  ) {}

  private get summaryTable(): any {
    return (this.prisma as any).themeAiSummary;
  }

  deduplicateArticles(articles: ThemeSummaryArticle[]): ThemeSummaryArticle[] {
    const seenTitles = new Set<string>();
    const seenUrls = new Set<string>();
    return articles.filter((article) => {
      const title = this.stripHtml(article.title).trim();
      const url = article.url.split('?')[0].replace(/\/$/, '');
      if (!title || !url || seenTitles.has(title) || seenUrls.has(url)) return false;
      seenTitles.add(title);
      seenUrls.add(url);
      article.title = title;
      article.description = this.stripHtml(article.description).trim();
      article.url = url;
      return true;
    });
  }

  validateLlmResult(result: any, articleCount: number): { summary: string; sourceIndexes: number[] } {
    const summary = typeof result?.summary === 'string' ? result.summary.trim() : '';
    const sourceIndexes = Array.isArray(result?.sourceIndexes)
      ? [...new Set(result.sourceIndexes.filter((index: unknown) => Number.isInteger(index) && Number(index) >= 0 && Number(index) < articleCount))] as number[]
      : [];
    if (!summary) throw new Error('요약 내용이 없습니다');
    if (sourceIndexes.length === 0) throw new Error('유효한 출처가 없습니다');
    return { summary, sourceIndexes };
  }

  async getLatestSuccess(themeCode: number) {
    return this.summaryTable.findFirst({
      where: { themeCode, status: 'SUCCESS' },
      orderBy: { tradeDate: 'desc' },
    });
  }

  async generateForTradeDate(tradeDate: Date, limit = 20, onlyThemeCode?: number) {
    if (!this.llm.isConfigured() || !this.news.isConfigured()) {
      return { targeted: 0, succeeded: 0, failed: 0, skipped: 1, failedThemeCodes: [] as number[] };
    }
    const snapshots = await this.prisma.themeDailySnapshot.findMany({
      where: { snapshotDate: tradeDate, ...(onlyThemeCode ? { themeCode: onlyThemeCode } : {}) },
      include: { theme: true },
      orderBy: { rank: 'asc' },
      take: Math.min(Math.max(limit, 1), 100),
    });
    let succeeded = 0;
    let failed = 0;
    let skipped = 0;
    const failedThemeCodes: number[] = [];

    for (const snapshot of snapshots) {
      try {
        const stockThemes = await this.prisma.stockTheme.findMany({
          where: { themeCode: snapshot.themeCode, source: 'NAVER' },
          select: { stockName: true },
          take: 5,
        });
        const stockNames = stockThemes.map((row) => row.stockName).filter((name): name is string => Boolean(name));
        const queries = [snapshot.theme.themeName, ...stockNames.slice(0, 3)];
        const searched = await Promise.all(queries.map((query) => this.news.search(query, 10).catch(() => [])));
        const articles = this.deduplicateArticles(searched.flat()).slice(0, 20);
        if (articles.length === 0) {
          skipped++;
          continue;
        }
        const raw = await this.llm.generateThemeSummary({
          themeName: snapshot.theme.themeName,
          stockNames,
          changeRate: Number(snapshot.avgChangeRate),
          risingCount: snapshot.risingCount,
          totalCount: snapshot.totalCount,
          articles,
        });
        const valid = this.validateLlmResult(raw, articles.length);
        const sources = valid.sourceIndexes.map((index) => articles[index]);
        await this.summaryTable.upsert({
          where: { themeCode_tradeDate: { themeCode: snapshot.themeCode, tradeDate } },
          create: { themeCode: snapshot.themeCode, tradeDate, summary: valid.summary, sourceArticles: sources as any, model: raw.model, status: 'SUCCESS', generatedAt: new Date() },
          update: { summary: valid.summary, sourceArticles: sources as any, model: raw.model, status: 'SUCCESS', errorMessage: null, generatedAt: new Date() },
        });
        succeeded++;
      } catch (error: any) {
        failed++;
        failedThemeCodes.push(snapshot.themeCode);
        this.logger.warn(`Theme AI summary failed for ${snapshot.themeCode}: ${error?.message ?? error}`);
        await this.summaryTable.upsert({
          where: { themeCode_tradeDate: { themeCode: snapshot.themeCode, tradeDate } },
          create: { themeCode: snapshot.themeCode, tradeDate, sourceArticles: [], status: 'FAILED', errorMessage: String(error?.message ?? error) },
          update: { status: 'FAILED', errorMessage: String(error?.message ?? error) },
        });
      }
    }
    return { targeted: snapshots.length, succeeded, failed, skipped, failedThemeCodes };
  }

  private stripHtml(value: string): string {
    return value.replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  }
}
