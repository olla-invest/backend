import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../common/prisma/prisma.service';
import { DartRestService } from '../../integrations/dart/dart-rest.service';
import axios from 'axios';

// 사업보고서: 11011, 반기: 11012, 1분기: 11013, 3분기: 11014
const REPRT_Q1     = '11013';
const REPRT_H1     = '11012'; // Q1+Q2 누적
const REPRT_Q3     = '11014'; // Q1+Q2+Q3 누적
const REPRT_ANNUAL = '11011'; // 연간

/**
 * 기본 조회 연도: 전년도
 */
function getDefaultYear(): string {
  return String(new Date().getFullYear() - 1);
}

export interface QuarterAmounts {
  q1: number | null;
  q2: number | null;
  q3: number | null;
  q4: number | null;
}

@Injectable()
export class StockInfoService {
  private readonly logger = new Logger(StockInfoService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly dart: DartRestService,
    private readonly config: ConfigService,
  ) {}

  /**
   * DART 고유번호 전체 동기화
   * stock_code가 있는 상장사만 Company 테이블에 corp_code 저장
   */
  async syncCorpCodes(): Promise<{ updated: number; total: number }> {
    this.logger.log('Syncing DART corp codes...');

    const corpList = await this.dart.getCorpCodeList();
    const listed = corpList.filter((c) => c.stockCode && c.stockCode.length === 6);

    this.logger.log(`Found ${listed.length} listed companies from DART`);

    let updated = 0;
    for (const item of listed) {
      const result = await this.prisma.company.updateMany({
        where: { stockCode: item.stockCode, deletedAt: null },
        data: { corpCode: item.corpCode },
      });
      if (result.count > 0) updated++;
    }

    this.logger.log(`Corp code sync done: ${updated} companies updated`);
    return { updated, total: listed.length };
  }

  /**
   * corp_code 조회 (없으면 에러)
   */
  private async getCorpCode(stockCode: string): Promise<string> {
    const company = await this.prisma.company.findFirst({
      where: { stockCode, deletedAt: null },
      select: { corpCode: true, companyName: true },
    });

    if (!company) throw new NotFoundException(`종목코드 ${stockCode}를 찾을 수 없습니다`);
    if (!company.corpCode) throw new NotFoundException(`${stockCode}의 DART 고유번호가 없습니다. /stock-info/sync-corp-codes 먼저 실행하세요`);

    return company.corpCode;
  }

  /**
   * 기업개황 (업종, 설립일, 결산월, 대표자 등)
   */
  async getCompanyOverview(stockCode: string) {
    const corpCode = await this.getCorpCode(stockCode);
    const data = await this.dart.getCompanyInfo(corpCode);

    if (data.status !== '000') throw new Error(`DART 기업개황 오류: ${data.message}`);

    return {
      stockCode,
      corpCode,
      corpName: data.corp_name,
      corpNameEng: data.corp_name_eng,
      ceoName: data.ceo_nm,
      corpClass: data.corp_cls,           // Y:유가, K:코스닥, N:코넥스
      industryCode: data.induty_code,
      establishedDate: data.est_dt,       // YYYYMMDD
      settlementMonth: data.acc_mt,       // MM
      address: data.adres,
      homepage: data.hm_url,
      phone: data.phn_no,
    };
  }

  /**
   * 손익현황 (매출액, 영업이익, 순이익 - 분기별)
   * Q2~Q4는 누적값 차분으로 standalone 환산
   */
  async getIncomeStatement(stockCode: string, year?: string) {
    const corpCode = await this.getCorpCode(stockCode);
    const bsnsYear = year || getDefaultYear();

    const [q1Res, h1Res, q3Res, annRes] = await Promise.allSettled([
      this.dart.getMainFinancials(corpCode, bsnsYear, REPRT_Q1),
      this.dart.getMainFinancials(corpCode, bsnsYear, REPRT_H1),
      this.dart.getMainFinancials(corpCode, bsnsYear, REPRT_Q3),
      this.dart.getMainFinancials(corpCode, bsnsYear, REPRT_ANNUAL),
    ]);

    const getISItems = (res: PromiseSettledResult<any>): any[] => {
      if (res.status !== 'fulfilled' || res.value.status !== '000') return [];
      const list: any[] = res.value.list || [];
      const cfs = list.filter((i) => i.fs_div === 'CFS' && i.sj_div === 'IS');
      return cfs.length > 0 ? cfs : list.filter((i) => i.fs_div === 'OFS' && i.sj_div === 'IS');
    };

    const parseAmt = (val: string | undefined): number | null =>
      val ? parseInt(val.replace(/,/g, ''), 10) : null;

    const pick = (items: any[], keywords: string[]) =>
      items.find((i) => keywords.some((kw) => i.account_nm?.includes(kw)));

    const q1Items = getISItems(q1Res);
    const h1Items = getISItems(h1Res);
    const q3Items = getISItems(q3Res);
    const annItems = getISItems(annRes);

    // CFS 여부는 연간 기준으로 판단
    const annList: any[] = annRes.status === 'fulfilled' ? (annRes.value.list || []) : [];
    const fsDiv = annList.some((i) => i.fs_div === 'CFS') ? 'CFS' : 'OFS';

    const calcQuarters = (keywords: string[]): QuarterAmounts => {
      const q1  = parseAmt(pick(q1Items, keywords)?.thstrm_amount);
      const h1  = parseAmt(pick(h1Items, keywords)?.thstrm_amount);
      const q3c = parseAmt(pick(q3Items, keywords)?.thstrm_amount);
      const ann = parseAmt(pick(annItems, keywords)?.thstrm_amount);
      return {
        q1,
        q2: h1 !== null && q1 !== null ? h1 - q1 : null,
        q3: q3c !== null && h1 !== null ? q3c - h1 : null,
        q4: ann !== null && q3c !== null ? ann - q3c : null,
      };
    };

    return {
      stockCode,
      year: bsnsYear,
      fsDiv,
      revenue:          calcQuarters(['매출액']),
      operatingIncome:  calcQuarters(['영업이익']),
      netIncome:        calcQuarters(['당기순이익']),
    };
  }

  /**
   * 현금흐름현황 (영업/투자/재무 - 분기별)
   * Q2~Q4는 누적값 차분으로 standalone 환산
   */
  async getCashFlow(stockCode: string, year?: string) {
    const corpCode = await this.getCorpCode(stockCode);
    const bsnsYear = year || getDefaultYear();

    const [q1Res, h1Res, q3Res, annRes] = await Promise.allSettled([
      this.dart.getFullFinancials(corpCode, bsnsYear, REPRT_Q1),
      this.dart.getFullFinancials(corpCode, bsnsYear, REPRT_H1),
      this.dart.getFullFinancials(corpCode, bsnsYear, REPRT_Q3),
      this.dart.getFullFinancials(corpCode, bsnsYear, REPRT_ANNUAL),
    ]);

    const getCFItems = (res: PromiseSettledResult<any>): any[] => {
      if (res.status !== 'fulfilled' || res.value.status !== '000') return [];
      return (res.value.list || []).filter((i: any) => i.sj_div === 'CF');
    };

    const parseAmt = (val: string | undefined): number | null =>
      val ? parseInt(val.replace(/,/g, ''), 10) : null;

    const pick = (items: any[], keywords: string[]) =>
      items.find((i) => keywords.some((kw) => i.account_nm?.includes(kw)));

    const q1Items = getCFItems(q1Res);
    const h1Items = getCFItems(h1Res);
    const q3Items = getCFItems(q3Res);
    const annItems = getCFItems(annRes);

    const calcQuarters = (keywords: string[]): QuarterAmounts => {
      const q1  = parseAmt(pick(q1Items, keywords)?.thstrm_amount);
      const h1  = parseAmt(pick(h1Items, keywords)?.thstrm_amount);
      const q3c = parseAmt(pick(q3Items, keywords)?.thstrm_amount);
      const ann = parseAmt(pick(annItems, keywords)?.thstrm_amount);
      return {
        q1,
        q2: h1 !== null && q1 !== null ? h1 - q1 : null,
        q3: q3c !== null && h1 !== null ? q3c - h1 : null,
        q4: ann !== null && q3c !== null ? ann - q3c : null,
      };
    };

    return {
      stockCode,
      year: bsnsYear,
      operatingCashFlow:  calcQuarters(['영업활동']),
      investingCashFlow:  calcQuarters(['투자활동']),
      financingCashFlow:  calcQuarters(['재무활동']),
    };
  }

  /**
   * 수익성/안정성 재무지표 (분기별)
   * 비율 지표는 누적 차분 없이 각 분기 보고서 값 그대로 사용
   */
  async getFinancialIndicators(stockCode: string, year?: string) {
    const corpCode = await this.getCorpCode(stockCode);
    const bsnsYear = year || getDefaultYear();

    const fetchQuarter = async (reprtCode: string) => {
      const [prof, stab, act] = await Promise.allSettled([
        this.dart.getFinancialIndicators(corpCode, bsnsYear, reprtCode, 'M210000'),
        this.dart.getFinancialIndicators(corpCode, bsnsYear, reprtCode, 'M220000'),
        this.dart.getFinancialIndicators(corpCode, bsnsYear, reprtCode, 'M240000'),
      ]);
      const toMap = (res: PromiseSettledResult<any>) => {
        const list = res.status === 'fulfilled' && res.value.status === '000' ? res.value.list || [] : [];
        return Object.fromEntries(list.map((i: any) => [i.idx_nm, i.idx_val]));
      };
      return { profitability: toMap(prof), stability: toMap(stab), activity: toMap(act) };
    };

    const [q1, q2, q3, q4] = await Promise.allSettled([
      fetchQuarter(REPRT_Q1),
      fetchQuarter(REPRT_H1),
      fetchQuarter(REPRT_Q3),
      fetchQuarter(REPRT_ANNUAL),
    ]);

    const safe = (res: PromiseSettledResult<any>) =>
      res.status === 'fulfilled' ? res.value : { profitability: {}, stability: {}, activity: {} };

    return {
      stockCode,
      year: bsnsYear,
      q1: safe(q1),
      q2: safe(q2),   // 반기 기준 지표
      q3: safe(q3),   // 9개월 기준 지표
      q4: safe(q4),
    };
  }

  /**
   * 네이버 뉴스 검색 (종목명 기준)
   */
  async searchNews(stockCode: string, display = 10, sort: 'date' | 'sim' = 'date', start = 1) {
    const company = await this.prisma.company.findFirst({
      where: { stockCode, deletedAt: null },
      select: { companyName: true },
    });
    if (!company) throw new NotFoundException(`종목코드 ${stockCode}를 찾을 수 없습니다`);

    const clientId     = this.config.get<string>('NAVER_CLIENT_ID');
    const clientSecret = this.config.get<string>('NAVER_CLIENT_SECRET');

    const res = await axios.get('https://openapi.naver.com/v1/search/news.json', {
      params: { query: company.companyName, display, sort, start },
      headers: {
        'X-Naver-Client-Id':     clientId,
        'X-Naver-Client-Secret': clientSecret,
      },
    });

    return {
      stockCode,
      companyName: company.companyName,
      total: res.data.total,
      items: res.data.items,
    };
  }

  /**
   * 종목정보 탭 통합 조회 (기업개황 + 손익 + 현금흐름 + 재무지표)
   */
  async getStockInfoSummary(stockCode: string, year?: string) {
    const [overview, income, cashFlow, indicators] = await Promise.allSettled([
      this.getCompanyOverview(stockCode),
      this.getIncomeStatement(stockCode, year),
      this.getCashFlow(stockCode, year),
      this.getFinancialIndicators(stockCode, year),
    ]);

    return {
      stockCode,
      overview: overview.status === 'fulfilled' ? overview.value : null,
      income: income.status === 'fulfilled' ? income.value : null,
      cashFlow: cashFlow.status === 'fulfilled' ? cashFlow.value : null,
      indicators: indicators.status === 'fulfilled' ? indicators.value : null,
    };
  }
}
