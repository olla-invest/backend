// 키움 API 공통 타입 정의

// OAuth 토큰 응답
export interface KiwoomTokenResponse {
  expires_dt: string;
  token_type: string;
  token: string;
  return_code: number;
  return_msg: string;
}

// WebSocket 실시간 등록 요청
export interface KiwoomRealtimeRequest {
  trnm: 'REG' | 'REMOVE';
  grp_no: string;
  refresh: '0' | '1';
  data: {
    item: string[];
    type: string[];
  }[];
}

// WebSocket 실시간 응답
export interface KiwoomRealtimeResponse {
  trnm: 'REG' | 'REMOVE' | 'REAL' | 'SYSTEM';
  return_code?: number;
  return_msg?: string;
  data?: {
    type: string;
    name: string;
    item: string;
    values: Record<string, string>;
  }[];
}

// 차트 데이터 응답 (분봉)
export interface KiwoomCandleData {
  cur_prc: string; // 현재가/종가
  trde_qty: string; // 거래량
  cntr_tm: string; // 체결시간 (YYYYMMDDHHmmss)
  open_pric: string; // 시가
  high_pric: string; // 고가
  low_pric: string; // 저가
  pred_pre: string; // 전일대비
  pred_pre_sig: string; // 전일대비기호
  acc_trde_qty?: string; // 누적거래량 (분봉)
}

// 차트 조회 응답 (분봉)
export interface KiwoomMinCandleResponse {
  stk_cd: string;
  stk_min_pole_chart_qry: KiwoomCandleData[];
  return_code: number;
  return_msg: string;
}

// 차트 조회 응답 (틱봉)
export interface KiwoomTickCandleResponse {
  stk_cd: string;
  last_tic_cnt: string;
  stk_tic_chart_qry: KiwoomCandleData[];
  return_code: number;
  return_msg: string;
}

// 차트 조회 응답 (일봉)
export interface KiwoomDayCandleData {
  cur_prc: string;
  trde_qty: string;
  trde_prica: string; // 거래대금
  dt: string; // 일자 (YYYYMMDD)
  open_pric: string;
  high_pric: string;
  low_pric: string;
  pred_pre: string;
  pred_pre_sig: string;
  trde_tern_rt: string; // 거래회전율
}

export interface KiwoomDayCandleResponse {
  stk_cd: string;
  stk_dt_pole_chart_qry: KiwoomDayCandleData[];
  return_code: number;
  return_msg: string;
}

// 실시간 체결 데이터 (0B)
export interface KiwoomTickData {
  '20': string; // 체결시간
  '10': string; // 현재가
  '11': string; // 전일대비
  '12': string; // 등락율
  '27': string; // 매도호가
  '28': string; // 매수호가
  '15': string; // 거래량
  '13': string; // 누적거래량
  '14': string; // 누적거래대금
  '16': string; // 시가
  '17': string; // 고가
  '18': string; // 저가
  '25': string; // 전일대비기호
  '228': string; // 체결강도
  [key: string]: string;
}

// 실시간 호가 데이터 (0D)
export interface KiwoomQuoteData {
  '21': string; // 호가시간
  '41': string; // 매도호가1
  '61': string; // 매도호가수량1
  '51': string; // 매수호가1
  '71': string; // 매수호가수량1
  '121': string; // 매도호가총잔량
  '125': string; // 매수호가총잔량
  [key: string]: string;
}

// 업종 일봉 데이터 (ka20006)
export interface KiwoomSectorDayCandleData {
  cur_prc: string; // 현재가 (지수 × 100)
  trde_qty: string; // 거래량
  dt: string; // 일자 (YYYYMMDD)
  open_pric: string; // 시가 (지수 × 100)
  high_pric: string; // 고가 (지수 × 100)
  low_pric: string; // 저가 (지수 × 100)
  trde_prica: string; // 거래대금
}

// 업종 일봉 조회 응답 (ka20006)
export interface KiwoomSectorDayCandleResponse {
  inds_cd: string;
  inds_dt_pole_qry: KiwoomSectorDayCandleData[];
  return_code: number;
  return_msg: string;
}

// 업종 현재가 응답 (ka20001)
export interface KiwoomSectorCurrentPriceResponse {
  cur_prc: string; // 현재가
  pred_pre_sig: string; // 전일대비기호
  pred_pre: string; // 전일대비
  flu_rt: string; // 등락률
  trde_qty: string; // 거래량
  trde_prica: string; // 거래대금
  open_pric: string; // 시가
  high_pric: string; // 고가
  low_pric: string; // 저가
  '52wk_hgst_pric': string; // 52주최고가
  '52wk_hgst_pric_dt': string; // 52주최고가일
  '52wk_lwst_pric': string; // 52주최저가
  '52wk_lwst_pric_dt': string; // 52주최저가일
  return_code: number;
  return_msg: string;
}

// API 호출 로그
export interface KiwoomApiLog {
  apiName: string;
  stockCode?: string;
  requestData?: any;
  responseStatus?: string;
  responseMessage?: string;
  responseTimeMs?: number;
}

// 종목 정보 (ka10099)
export interface KiwoomStockInfo {
  code: string;
  name: string;
  listCount: string;
  auditInfo: string;
  regDay: string;
  lastPrice: string;
  state: string;
  marketCode: string;
  marketName: string;
  upName: string;
  upSizeName: string;
  companyClassName: string;
  orderWarning: string;
  nxtEnable: string;
  kind?: string;
}

// 종목 리스트 응답 (ka10099)
export interface KiwoomStockListResponse {
  return_code: number;
  return_msg: string;
  list: KiwoomStockInfo[];
}
