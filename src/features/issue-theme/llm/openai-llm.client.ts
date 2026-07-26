import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { GenerateThemeSummaryInput, GenerateThemeSummaryResult, LlmClient } from './llm-client.interface';

@Injectable()
export class OpenAiLlmClient implements LlmClient {
  constructor(private readonly config: ConfigService) {}

  isConfigured(): boolean {
    return Boolean(this.config.get<string>('OPENAI_API_KEY'));
  }

  async generateThemeSummary(input: GenerateThemeSummaryInput): Promise<GenerateThemeSummaryResult> {
    const apiKey = this.config.get<string>('OPENAI_API_KEY');
    if (!apiKey) throw new Error('OPENAI_API_KEY is not configured');
    const model = this.config.get<string>('OPENAI_THEME_SUMMARY_MODEL', 'gpt-5.6-luna');
    const articleText = input.articles.map((article, index) =>
      `[${index}] ${article.title}\n${article.description}\n${article.publishedAt} ${article.url}`,
    ).join('\n\n');
    const response = await axios.post('https://api.openai.com/v1/responses', {
      model,
      reasoning: { effort: 'low' },
      input: [
        {
          role: 'system',
          content: '당신은 한국 주식시장 테마 뉴스 요약기입니다. 기사에 명시된 사실만 사용하고 전망, 투자 권유, 기사 나열을 하지 마세요.',
        },
        {
          role: 'user',
          content: `테마: ${input.themeName}\n주요 종목: ${input.stockNames.join(', ')}\n평균 등락률: ${input.changeRate}%\n상승 종목: ${input.risingCount}/${input.totalCount}\n\n최근 기사:\n${articleText}\n\n시장 반응 원인을 한국어 2~4문장으로 요약하고 근거 기사 인덱스를 선택하세요.`,
        },
      ],
      text: {
        format: {
          type: 'json_schema',
          name: 'theme_summary',
          strict: true,
          schema: {
            type: 'object',
            properties: {
              summary: { type: 'string' },
              sourceIndexes: { type: 'array', items: { type: 'integer' }, minItems: 1 },
            },
            required: ['summary', 'sourceIndexes'],
            additionalProperties: false,
          },
        },
      },
      max_output_tokens: 500,
    }, {
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      timeout: 30_000,
    });

    const text = response.data.output?.flatMap((item: any) => item.content ?? [])
      .find((content: any) => content.type === 'output_text')?.text;
    if (!text) throw new Error('OpenAI response did not contain output text');
    const parsed = JSON.parse(text);
    return { ...parsed, model };
  }
}
