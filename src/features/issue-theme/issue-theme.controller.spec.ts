import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../../common/prisma/prisma.service';
import { JwtStrategy } from '../../common/auth/strategies/jwt.strategy';
import { IssueThemeController } from './issue-theme.controller';
import { IssueThemeService } from './issue-theme.service';
import { ThemeSnapshotService } from './theme-snapshot.service';

describe('IssueThemeController optional authentication', () => {
  let app: INestApplication;
  let baseUrl: string;
  const getThemeList = jest.fn();
  const buildDailySnapshot = jest.fn();
  const backfillFromStockSnapshots = jest.fn();

  beforeAll(async () => {
    const jwtSecret = 'issue-theme-controller-test-secret';
    const moduleRef = await Test.createTestingModule({
      imports: [
        PassportModule.register({ defaultStrategy: 'jwt' }),
        JwtModule.register({ secret: jwtSecret }),
      ],
      controllers: [IssueThemeController],
      providers: [
        JwtStrategy,
        { provide: IssueThemeService, useValue: { getThemeList } },
        { provide: ThemeSnapshotService, useValue: { buildDailySnapshot, backfillFromStockSnapshots } },
        {
          provide: PrismaService,
          useValue: {
            user: {
              findUnique: jest.fn().mockResolvedValue({
                userId: 'user-1',
                username: 'tester',
                email: 'tester@example.com',
              }),
            },
          },
        },
        {
          provide: ConfigService,
          useValue: { get: jest.fn((key: string) => key === 'JWT_SECRET' ? jwtSecret : undefined) },
        },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address();
    if (typeof address === 'string' || address == null) throw new Error('Expected TCP test server address');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    getThemeList.mockReset();
    getThemeList.mockImplementation((_query: unknown, userId?: string) => ({
      items: [
        { themeCode: 1, isFavorite: userId === 'user-1' },
        { themeCode: 2, isFavorite: false },
      ],
    }));
  });

  it('passes the authenticated user to the list and returns favorite state', async () => {
    const jwtService = app.get(JwtService);
    const token = jwtService.sign({
      sub: 'user-1',
      username: 'tester',
      email: 'tester@example.com',
    });

    const response = await fetch(`${baseUrl}/issue-theme`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      items: [
        { themeCode: 1, isFavorite: true },
        { themeCode: 2, isFavorite: false },
      ],
    });
    expect(getThemeList).toHaveBeenCalledWith(expect.anything(), 'user-1');
  });

  it('routes theme backfill through stock-snapshot reconstruction', async () => {
    backfillFromStockSnapshots.mockResolvedValue({ requestedDays: 3, rebuiltDates: [], skippedDates: [] });
    const controller = app.get(IssueThemeController);

    await controller.backfillThemeSnapshots(3);

    expect(backfillFromStockSnapshots).toHaveBeenCalledWith(3);
  });
});
