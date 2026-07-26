import { Transform } from 'class-transformer';
import { IsBoolean, IsEnum, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

export enum IssueThemeView {
  RANK = 'rank',
  HEATMAP = 'heatmap',
}

export enum IssueThemeFilter {
  ALL = 'all',
  RS80 = 'rs80',
  MOMENTUM = 'momentum',
  STOCK_COUNT_5 = 'stockCount5',
  CHANGE_RATE_5 = 'changeRate5',
  HAS_NEW_HIGH = 'hasNewHigh',
}

export enum IssueThemeSort {
  RS = 'rs',
  CHANGE_RATE = 'changeRate',
  PREVIOUS_RANK = 'previousRank',
}

export class IssueThemeListQueryDto {
  @IsOptional()
  @IsString()
  search?: string;

  @IsEnum(IssueThemeView)
  view: IssueThemeView = IssueThemeView.RANK;

  @IsEnum(IssueThemeFilter)
  filter: IssueThemeFilter = IssueThemeFilter.ALL;

  @IsEnum(IssueThemeSort)
  sort: IssueThemeSort = IssueThemeSort.RS;

  @Transform(({ value }) => value === 'true' ? true : value === 'false' ? false : value)
  @IsBoolean()
  favoritesOnly = false;

  @Transform(({ value }) => value == null ? 20 : Number(value))
  @IsInt()
  @Min(1)
  @Max(300)
  display = 20;

  @Transform(({ value }) => value == null ? 1 : Number(value))
  @IsInt()
  @Min(1)
  page = 1;
}
