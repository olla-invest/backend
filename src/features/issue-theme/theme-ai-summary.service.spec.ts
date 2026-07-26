import { ThemeAiSummaryService } from './theme-ai-summary.service';

describe('ThemeAiSummaryService', () => {
  const prisma: any = { themeAiSummary: { upsert: jest.fn(), findFirst: jest.fn() } };
  const service = new ThemeAiSummaryService(prisma, {} as any, {} as any);

  beforeEach(() => jest.clearAllMocks());

  it('deduplicates news by normalized URL and title', () => {
    const articles = service.deduplicateArticles([
      { title: '<b>로봇</b> 투자 확대', description: 'a', url: 'https://news.test/a?utm_source=x', publishedAt: '2026-07-25' },
      { title: '로봇 투자 확대', description: 'b', url: 'https://news.test/b', publishedAt: '2026-07-25' },
      { title: '다른 기사', description: 'c', url: 'https://news.test/a', publishedAt: '2026-07-25' },
    ]);

    expect(articles).toHaveLength(1);
    expect(articles[0].title).toBe('로봇 투자 확대');
  });

  it('rejects a summary without valid source indexes', () => {
    expect(() => service.validateLlmResult({ summary: '근거 없는 요약입니다.', sourceIndexes: [3] }, 2))
      .toThrow('유효한 출처');
  });

  it('accepts a sourced structured summary', () => {
    expect(service.validateLlmResult({
      summary: '정부 정책과 기업 투자가 확대되며 로봇 테마가 강세를 보였습니다.',
      sourceIndexes: [0, 1],
    }, 2)).toEqual({
      summary: '정부 정책과 기업 투자가 확대되며 로봇 테마가 강세를 보였습니다.',
      sourceIndexes: [0, 1],
    });
  });
});
