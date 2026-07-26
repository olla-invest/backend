import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  IssueThemeFilter,
  IssueThemeListQueryDto,
  IssueThemeSort,
  IssueThemeView,
} from './issue-theme-list-query.dto';
import { IssueThemeDetailQueryDto, IssueThemeStockSort } from './issue-theme-detail-query.dto';

describe('issue theme query DTOs', () => {
  it('applies list defaults and transforms primitives', async () => {
    const dto = plainToInstance(IssueThemeListQueryDto, {
      favoritesOnly: 'true',
      display: '30',
      page: '2',
    });

    expect(await validate(dto)).toEqual([]);
    expect(dto).toMatchObject({
      view: IssueThemeView.RANK,
      filter: IssueThemeFilter.ALL,
      sort: IssueThemeSort.RS,
      favoritesOnly: true,
      display: 30,
      page: 2,
    });
  });

  it('rejects invalid list enums and ranges', async () => {
    const dto = plainToInstance(IssueThemeListQueryDto, {
      view: 'grid', filter: 'unknown', sort: 'name', display: '0', page: '-1',
    });
    expect((await validate(dto)).length).toBeGreaterThanOrEqual(5);
  });

  it('applies detail defaults and validates stock sorting', async () => {
    const dto = plainToInstance(IssueThemeDetailQueryDto, {});
    expect(await validate(dto)).toEqual([]);
    expect(dto).toMatchObject({ stockSort: IssueThemeStockSort.RS, stockDisplay: 20 });

    const invalid = plainToInstance(IssueThemeDetailQueryDto, { stockSort: 'name', stockDisplay: '301' });
    expect((await validate(invalid)).length).toBe(2);
  });
});
