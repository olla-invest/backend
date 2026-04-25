import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../common/prisma/prisma.service';
import { DartRestService } from '../../integrations/dart/dart-rest.service';
import axios from 'axios';
import AdmZip = require('adm-zip');
import * as cheerio from 'cheerio';

// KSIC 업종코드 → 업종명 매핑 (앞자리 매칭, 긴 코드 우선)
const KSIC_NAME: Record<string, string> = {
  '011':'종자·묘목', '012':'채소·화훼', '013':'과실', '014':'낙농업', '015':'가금류', '016':'기타축산', '017':'혼합농업',
  '021':'임업', '031':'어로어업', '032':'양식업',
  '101':'육류가공', '1012':'가금류가공', '10121':'닭고기도축', '102':'수산물가공', '10211':'수산통조림',
  '103':'과실·채소가공', '104':'유제품', '105':'곡물·사료', '10520':'전분', '106':'제과·제빵',
  '107':'빙과류', '108':'기타식품', '10897':'건강기능식품', '109':'동물사료',
  '11111':'막걸리', '11112':'과실주', '11121':'에탄올', '11122':'소주·맥주', '11209':'음료',
  '120':'담배', '12000':'담배',
  '131':'면방적', '13101':'면방적', '132':'모방적', '133':'화섬방적', '134':'직물',
  '135':'편조원단', '139':'기타섬유', '141':'의류', '151':'가죽제품', '152':'신발',
  '161':'목재', '162':'합판·목재패널', '170':'펄프·종이', '171':'제지', '172':'종이제품',
  '181':'인쇄', '182':'인쇄관련',
  '191':'석유정제', '192':'연탄·석탄', '19221':'윤활유',
  '201':'기초화학', '20111':'기초화학', '202':'농약·비료', '203':'도료·잉크', '204':'의약품원료',
  '20421':'의약품원료', '20422':'바이오원료', '20423':'계면활성제',
  '205':'화장품', '206':'기타화학', '207':'화학섬유',
  '221':'고무제품', '222':'플라스틱',
  '231':'유리', '232':'도자기', '233':'시멘트', '239':'기타비금속',
  '241':'제철·제강', '2411':'제철·제강', '2412':'철강압연', '24133':'철강압연',
  '242':'비철금속', '24312':'비철금속주조', '243':'금속주조',
  '251':'구조용금속', '2511':'구조용금속', '252':'무기·탄약', '259':'기타금속',
  '261':'반도체소자', '2612':'반도체소자', '262':'전자부품', '2621':'전자관',
  '2629':'전자부품', '26291':'기타전자부품', '263':'통신장비', '264':'반도체',
  '26329':'광학렌즈', '26429':'기타반도체', '265':'가전제품', '266':'영상·음향', '269':'기타전자',
  '271':'의료기기', '272':'측정기기', '273':'광학기기', '274':'시계', '27216':'의료영상기기',
  '281':'전동기·발전기', '282':'2차전지', '283':'절연전선·케이블', '284':'전구·조명', '285':'가정용기기', '289':'기타전기장비',
  '291':'일반기계', '292':'특수목적기계', '29271':'반도체장비', '29272':'디스플레이장비',
  '29299':'기타특수기계', '293':'자동차엔진', '303':'항공우주',
  '301':'완성차', '302':'자동차부품', '30311':'선박건조', '3031':'조선', '304':'자전거·오토바이',
  '320':'가구', '331':'의료기기', '339':'기타제조',
  '351':'발전', '352':'가스공급', '353':'증기·냉난방', '360':'수도', '381':'폐수처리', '382':'폐기물처리',
  '411':'건물건설', '412':'토목건설', '421':'토목시설', '422':'건물건설',
  '451':'자동차판매', '461':'농산물도매', '462':'식품도매', '463':'소비재도매',
  '464':'기계·장비도매', '465':'IT·전자도매', '469':'기타도매',
  '471':'종합소매', '472':'식품소매', '473':'연료소매', '478':'무점포소매·이커머스',
  '491':'철도운송', '492':'육상운송', '493':'파이프라인', '501':'해운', '511':'항공운송', '521':'창고·물류',
  '551':'호텔', '552':'여관·숙박', '561':'음식점',
  '581':'출판', '582':'소프트웨어출판·게임', '591':'영화·영상', '592':'음악',
  '601':'라디오방송', '602':'TV방송', '612':'유선통신', '613':'무선통신', '619':'기타통신',
  '620':'소프트웨어', '621':'소프트웨어개발', '622':'IT시스템통합', '629':'기타IT서비스',
  '630':'정보서비스', '631':'데이터·클라우드', '639':'포털·정보서비스',
  '641':'은행', '642':'저축은행', '643':'신용협동조합', '649':'기타금융',
  '64992':'기타금융', '64201':'은행', '651':'생명보험', '652':'손해보험', '653':'재보험',
  '661':'증권·금융투자', '662':'펀드·신탁', '663':'금융지원',
  '681':'부동산개발', '682':'부동산임대·리츠', '683':'부동산중개',
  '701':'R&D', '702':'바이오R&D', '711':'법무·회계', '712':'건축·설계', '713':'엔지니어링',
  '714':'기술검사', '715':'기타전문서비스', '70113':'경영컨설팅',
  '721':'광고·마케팅', '722':'시장조사', '731':'사진·영상', '733':'전시·행사',
  '771':'임대업', '781':'여행업', '791':'경비·보안', '811':'건물관리', '813':'사무지원',
  '851':'초중고교육', '852':'고등교육', '855':'이러닝', '856':'학원',
  '861':'병원', '862':'의원', '869':'기타의료',
  '901':'창작·예술', '911':'스포츠', '912':'놀이공원·레저',
  '951':'자동차수리', '952':'가전수리',
};

function getIndustryName(code: string): string {
  const c = String(code || '').trim();
  for (const len of [5, 4, 3, 2]) {
    const name = KSIC_NAME[c.slice(0, len)];
    if (name) return name;
  }
  return code || '-';
}

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
   * 기업개황 (업종, 설립일, 결산월, 대표자 등) + 시가총액
   */
  async getCompanyOverview(stockCode: string) {
    const corpCode = await this.getCorpCode(stockCode);

    const [dartData, company, latestCandle] = await Promise.all([
      this.dart.getCompanyInfo(corpCode),
      this.prisma.company.findFirst({
        where: { stockCode, deletedAt: null },
        select: { listedShares: true, businessInfo: true, themeCode: true, theme: { select: { themeName: true } } },
      }),
      this.prisma.stockCandle.findFirst({
        where: { stockCode, candleType: 'day' },
        orderBy: { candleTime: 'desc' },
        select: { closePrice: true },
      }),
    ]);

    if (dartData.status !== '000') throw new Error(`DART 기업개황 오류: ${dartData.message}`);

    const listedShares = company?.listedShares ?? null;
    const closePrice = latestCandle ? Number(latestCandle.closePrice) : null;
    const marketCap = listedShares && closePrice
      ? Number(listedShares) * closePrice
      : null;

    return {
      stockCode,
      corpCode,
      corpName: dartData.corp_name,
      corpNameEng: dartData.corp_name_eng,
      ceoName: dartData.ceo_nm,
      corpClass: dartData.corp_cls,
      industryCode: dartData.induty_code,
      industryName: getIndustryName(dartData.induty_code),
      establishedDate: dartData.est_dt,
      settlementMonth: dartData.acc_mt,
      address: dartData.adres,
      homepage: dartData.hm_url,
      phone: dartData.phn_no,
      listedShares: listedShares ? Number(listedShares) : null,
      marketCap,
      theme: company?.theme?.themeName ?? null,
      businessInfo: company?.businessInfo ?? null,
    };
  }

  /**
   * 상장주식수 동기화 (DART stockTotqySttus → Company.listedShares)
   * - 전년도 사업보고서 기준
   * - stockCode 지정 시 단건, 없으면 corpCode 있는 전체 종목
   */
  async syncListedShares(stockCode?: string): Promise<{ updated: number; failed: number }> {
    const where = stockCode
      ? { stockCode, corpCode: { not: null }, deletedAt: null }
      : { corpCode: { not: null }, deletedAt: null };

    const companies = await this.prisma.company.findMany({
      where,
      select: { stockCode: true, corpCode: true },
    });

    const bsnsYear = getDefaultYear();
    let updated = 0;
    let failed = 0;

    for (const company of companies) {
      try {
        const res = await this.dart.getStockTotalShares(company.corpCode!, bsnsYear);
        if (res.status !== '000' || !res.list?.length) { failed++; continue; }

        // 보통주 발행주식총수
        const commonStock = res.list.find((i: any) =>
          i.se?.includes('보통주') || i.se?.includes('합계'),
        );
        if (!commonStock?.isu_stock_totqy) { failed++; continue; }

        const shares = BigInt(String(commonStock.isu_stock_totqy).replace(/,/g, ''));
        await this.prisma.company.updateMany({
          where: { stockCode: company.stockCode, deletedAt: null },
          data: { listedShares: shares },
        });
        updated++;
      } catch {
        failed++;
      }
    }

    this.logger.log(`syncListedShares done: updated=${updated}, failed=${failed}`);
    return { updated, failed };
  }

  /**
   * 사업보고서 ZIP(DART XML 형식)에서 "사업의 내용" 텍스트 추출
   * DART 원문 ZIP은 .xml 파일로 구성 (DART 고유 XML 태그 사용)
   */
  private extractBusinessContent(zipBuffer: Buffer): string | null {
    const zip = new AdmZip(zipBuffer);
    const entries = zip.getEntries();

    // .xml 파일만 대상 (메인 파일 우선: _ 없는 파일명)
    const xmlEntries = entries.filter((e) => e.entryName.endsWith('.xml'));
    if (!xmlEntries.length) return null;

    const mainEntry =
      xmlEntries.find((e) => !e.entryName.includes('_')) ?? xmlEntries[0];

    const xmlContent = mainEntry.getData().toString('utf-8');
    const $ = cheerio.load(xmlContent, { xmlMode: true });

    // "사업의 내용" / "주요사업의 내용" 마커 이후 <P> 태그 텍스트 수집
    let content = '';
    let capturing = false;
    let capturedChars = 0;
    const MAX_CHARS = 3000;

    $('P, SPAN').each((_, el) => {
      if (capturedChars >= MAX_CHARS) return false;
      const text = $(el).text().replace(/\s+/g, ' ').trim();

      if (!capturing && /사업의\s*내용|주요\s*사업/.test(text)) {
        capturing = true;
        return;
      }
      // 다음 대섹션 만나면 중단
      if (capturing && /^[가-힣]\.\s*(재무|위험|지배구조|주주|감사|임원)/.test(text) && text.length < 40) {
        return false;
      }
      if (capturing && $(el).is('P') && text.length > 15) {
        content += text + '\n';
        capturedChars += text.length;
      }
    });

    return content.trim() || null;
  }

  /**
   * 텍스트에서 주요사업 키워드 요약 (규칙 기반)
   * - 첫 문단 + 사업 키워드 문장 추출
   */
  private summarizeBusinessContent(text: string): string {
    const sentences = text.split(/[.\n]/).map((s) => s.trim()).filter((s) => s.length > 15);
    const keywords = ['제조', '판매', '개발', '서비스', '유통', '수출', '생산', '공급', '운영', '사업'];
    const picked: string[] = [];

    // 첫 문장은 무조건 포함
    if (sentences[0]) picked.push(sentences[0]);

    // 키워드 포함 문장 최대 3개 추가
    for (const s of sentences.slice(1)) {
      if (picked.length >= 4) break;
      if (keywords.some((kw) => s.includes(kw))) picked.push(s);
    }

    return picked.join('. ').slice(0, 500);
  }

  /**
   * 주요사업 정보 동기화 (DART 사업보고서 → Company.businessInfo)
   * - stockCode 지정 시 단건, 없으면 전체
   */
  async syncBusinessInfo(stockCode?: string): Promise<{ updated: number; failed: number; skipped: number }> {
    const where = stockCode
      ? { stockCode, corpCode: { not: null }, deletedAt: null }
      : { corpCode: { not: null }, deletedAt: null };

    const companies = await this.prisma.company.findMany({
      where,
      select: { stockCode: true, corpCode: true },
    });

    const year = getDefaultYear();
    let updated = 0, failed = 0, skipped = 0;

    for (const company of companies) {
      try {
        // 1. 사업보고서 접수번호 조회
        const rcpNo = await this.dart.getAnnualReportRcpNo(company.corpCode!, year);
        if (!rcpNo) { skipped++; continue; }

        // 2. 원문 ZIP 다운로드
        const zipBuffer = await this.dart.getDocumentZip(rcpNo);

        // 3. "사업의 내용" 텍스트 추출
        const rawText = this.extractBusinessContent(zipBuffer);
        if (!rawText) { skipped++; continue; }

        // 4. 키워드 기반 요약
        const summary = this.summarizeBusinessContent(rawText);

        // 5. Company 테이블 저장
        const businessInfo = {
          summary,
          year,
          source: 'DART',
          rcpNo,
          updatedAt: new Date().toISOString(),
        };

        await this.prisma.company.updateMany({
          where: { stockCode: company.stockCode, deletedAt: null },
          data: { businessInfo },
        });
        updated++;
        this.logger.log(`[syncBusinessInfo] ${company.stockCode} updated`);
      } catch (e) {
        this.logger.warn(`[syncBusinessInfo] ${company.stockCode} failed: ${(e as Error).message}`);
        failed++;
      }
    }

    this.logger.log(`syncBusinessInfo done: updated=${updated}, failed=${failed}, skipped=${skipped}`);
    return { updated, failed, skipped };
  }

  /**
   * 디버그: DART list.json 직접 조회 결과 반환
   */
  async debugDartList(stockCode: string) {
    const corpCode = await this.getCorpCode(stockCode);
    const year = getDefaultYear();
    const nextYear = String(parseInt(year) + 1);
    const rcpNo = await this.dart.getAnnualReportRcpNo(corpCode, year);
    return { stockCode, corpCode, year, nextYear, rcpNo };
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
