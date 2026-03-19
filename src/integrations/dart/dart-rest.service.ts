import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import AdmZip = require('adm-zip');
import * as xml2js from 'xml2js';

const DART_BASE_URL = 'https://opendart.fss.or.kr/api';

@Injectable()
export class DartRestService {
  private readonly logger = new Logger(DartRestService.name);
  private readonly apiKey: string;

  constructor(private readonly config: ConfigService) {
    this.apiKey = this.config.get<string>('DART_API_KEY') || '';
  }

  /**
   * 고유번호 목록 다운로드 (ZIP → XML 파싱)
   * 반환: { corp_code, corp_name, stock_code, modify_date }[]
   */
  async getCorpCodeList(): Promise<Array<{
    corpCode: string;
    corpName: string;
    stockCode: string;
    modifyDate: string;
  }>> {
    this.logger.log('Downloading DART corp code list...');

    const response = await axios.get(`${DART_BASE_URL}/corpCode.xml`, {
      params: { crtfc_key: this.apiKey },
      responseType: 'arraybuffer',
    });

    const zip = new AdmZip(Buffer.from(response.data));
    const xmlEntry = zip.getEntries().find((e) => e.entryName.endsWith('.xml'));
    if (!xmlEntry) throw new Error('XML file not found in DART corp code ZIP');

    const xmlContent = xmlEntry.getData().toString('utf-8');
    const parsed = await xml2js.parseStringPromise(xmlContent, { explicitArray: false });

    const list = parsed?.result?.list;
    if (!list) return [];

    const items = Array.isArray(list) ? list : [list];
    return items.map((item: any) => ({
      corpCode: item.corp_code,
      corpName: item.corp_name,
      stockCode: item.stock_code?.trim() || '',
      modifyDate: item.modify_date,
    }));
  }

  /**
   * 기업개황 조회
   */
  async getCompanyInfo(corpCode: string) {
    const res = await axios.get(`${DART_BASE_URL}/company.json`, {
      params: { crtfc_key: this.apiKey, corp_code: corpCode },
    });
    return res.data;
  }

  /**
   * 단일회사 주요계정 (손익계산서 + 재무상태표)
   */
  async getMainFinancials(corpCode: string, bsnsYear: string, reprtCode: string) {
    const res = await axios.get(`${DART_BASE_URL}/fnlttSinglAcnt.json`, {
      params: {
        crtfc_key: this.apiKey,
        corp_code: corpCode,
        bsns_year: bsnsYear,
        reprt_code: reprtCode,
      },
    });
    return res.data;
  }

  /**
   * 단일회사 전체 재무제표 (현금흐름표 등)
   */
  async getFullFinancials(corpCode: string, bsnsYear: string, reprtCode: string, fsDiv: 'OFS' | 'CFS' = 'CFS') {
    const res = await axios.get(`${DART_BASE_URL}/fnlttSinglAcntAll.json`, {
      params: {
        crtfc_key: this.apiKey,
        corp_code: corpCode,
        bsns_year: bsnsYear,
        reprt_code: reprtCode,
        fs_div: fsDiv,
      },
    });
    return res.data;
  }

  /**
   * 단일회사 주요 재무지표
   * idx_cl_code: M210000(수익성), M220000(안정성), M230000(성장성), M240000(활동성)
   */
  async getFinancialIndicators(corpCode: string, bsnsYear: string, reprtCode: string, idxClCode: string) {
    const res = await axios.get(`${DART_BASE_URL}/fnlttSinglIndx.json`, {
      params: {
        crtfc_key: this.apiKey,
        corp_code: corpCode,
        bsns_year: bsnsYear,
        reprt_code: reprtCode,
        idx_cl_code: idxClCode,
      },
    });
    return res.data;
  }
}
