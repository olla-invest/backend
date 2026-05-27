import { ApiProperty } from '@nestjs/swagger';

export class StockNewsItemDto {
  @ApiProperty({ example: 'Samsung Electronics announces new AI chip' })
  title: string;

  @ApiProperty({ example: 'Article summary text' })
  description: string;

  @ApiProperty({ example: 'Fri, 15 May 2026 09:30:00 +0900' })
  pubDate: string;

  @ApiProperty({ example: 'https://news.naver.com/example' })
  link: string;

  @ApiProperty({ example: 'https://www.hankyung.com/article/2026051500001' })
  originUrl: string;

  @ApiProperty({ example: 'Korea Economic Daily' })
  mediaName: string;
}

export class StockNewsResponseDto {
  @ApiProperty({ example: '005930' })
  stockCode: string;

  @ApiProperty({ example: 'Samsung Electronics' })
  companyName: string;

  @ApiProperty({ example: 1324 })
  total: number;

  @ApiProperty({ type: [StockNewsItemDto] })
  items: StockNewsItemDto[];
}
