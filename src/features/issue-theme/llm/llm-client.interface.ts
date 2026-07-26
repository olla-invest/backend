export const LLM_CLIENT = Symbol('LLM_CLIENT');

export interface ThemeSummaryArticle {
  title: string;
  description: string;
  url: string;
  publishedAt: string;
  mediaName?: string;
}

export interface GenerateThemeSummaryInput {
  themeName: string;
  stockNames: string[];
  changeRate: number;
  risingCount: number;
  totalCount: number;
  articles: ThemeSummaryArticle[];
}

export interface GenerateThemeSummaryResult {
  summary: string;
  sourceIndexes: number[];
  model: string;
}

export interface LlmClient {
  isConfigured(): boolean;
  generateThemeSummary(input: GenerateThemeSummaryInput): Promise<GenerateThemeSummaryResult>;
}
