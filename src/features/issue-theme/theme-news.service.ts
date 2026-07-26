import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { ThemeSummaryArticle } from './llm/llm-client.interface';

@Injectable()
export class ThemeNewsService {
  constructor(private readonly config: ConfigService) {}

  isConfigured(): boolean {
    return Boolean(this.config.get<string>('NAVER_CLIENT_ID') && this.config.get<string>('NAVER_CLIENT_SECRET'));
  }

  async search(query: string, display = 10): Promise<ThemeSummaryArticle[]> {
    const response = await axios.get('https://openapi.naver.com/v1/search/news.json', {
      params: { query, display, sort: 'date', start: 1 },
      headers: {
        'X-Naver-Client-Id': this.config.get<string>('NAVER_CLIENT_ID'),
        'X-Naver-Client-Secret': this.config.get<string>('NAVER_CLIENT_SECRET'),
      },
      timeout: 10_000,
    });
    return (response.data.items ?? []).map((item: any) => ({
      title: item.title ?? '',
      description: item.description ?? '',
      url: item.originallink ?? item.link ?? '',
      publishedAt: item.pubDate ?? '',
    }));
  }
}
