import { Transform } from 'class-transformer';
import { IsEnum, IsInt, Max, Min } from 'class-validator';

export enum IssueThemeStockSort {
  RS = 'rs',
  SHORT_TERM_RS = 'shortTermRs',
  CHANGE_RATE = 'changeRate',
  TRADING_VALUE = 'tradingValue',
  PREVIOUS_RATIO = 'previousRatio',
  NEW_HIGH = 'newHigh',
}

export class IssueThemeDetailQueryDto {
  @IsEnum(IssueThemeStockSort)
  stockSort: IssueThemeStockSort = IssueThemeStockSort.RS;

  @Transform(({ value }) => value == null ? 20 : Number(value))
  @IsInt()
  @Min(1)
  @Max(300)
  stockDisplay = 20;
}
