# RS 검증 분석

외부 검증시트와 Olla 데이터의 차이를 분석합니다. 입력은 탭 구분 3섹션 형식입니다.

## 입력 형식 (탭 구분)

```
검증시트에있는데olla에없는건  olla에있는데검증시트에없는건  RS점수차이나는건
코드  종목명  코드  종목명  코드  종목명  리스트점수  올라점수
...
```

## 파싱 규칙

$ARGUMENTS 가 비어있으면 사용자에게 데이터를 붙여넣어달라고 요청하세요.
데이터는 탭(\t) 또는 여러 공백으로 구분된 컬럼입니다. 행마다 최대 8개 컬럼:
- col 0-1: 검증시트O/OllaX (코드, 종목명)
- col 2-3: 검증시트X/OllaO (코드, 종목명)
- col 4-7: RS점수차이 (코드, 종목명, 리스트점수, 올라점수)

각 셀은 비어있을 수 있습니다 (섹션마다 행수가 다를 수 있음).

---

## 분석 절차

### 1. [검증시트O / OllaX] — Olla에 없는 이유 파악

각 종목코드에 대해 DB를 조회합니다:

```sql
-- stock_daily_metrics에서 해당 코드 최근 데이터 확인
SELECT trade_date, rank, relative_strength_score, passed_static_filters, is_trend_template
FROM stock_daily_metrics
WHERE stock_code = '<코드>'
ORDER BY trade_date DESC
LIMIT 5;
```

```sql
-- companies 테이블에서 존재 여부 확인
SELECT stock_code, company_name, market_type
FROM companies
WHERE stock_code = '<코드>';
```

판단 기준:
- companies에 없음 → 종목 자체가 DB에 미등록
- metrics에 있고 rank=0 → 정적/동적 필터 탈락
- metrics에 있고 rank>0 → 순위 컷오프 외 (리스트 기준 다름)
- metrics에 없음 → 해당 날짜 계산 누락

### 2. [검증시트X / OllaO] — Olla에 있는데 외부리스트에 없는 이유 파악

```sql
SELECT m.trade_date, m.rank, m.relative_strength_score, m.close_price,
       m.passed_static_filters, m.is_trend_template
FROM stock_daily_metrics m
WHERE m.stock_code = '<코드>'
ORDER BY m.trade_date DESC
LIMIT 3;
```

판단: rank가 낮으면(상위권) 외부리스트 기준이 다른 것. RS점수, 필터 조건 차이 서술.

### 3. [RS점수 차이] — 실제 종가 기반 재계산

각 종목에 대해:

**Step A: DB에서 Olla 계산 상세값 조회**

```sql
SELECT m.trade_date, m.rank, m.relative_strength_score,
       m.close_price, m.market_type,
       m.price_change_rate_1d, m.passed_static_filters
FROM stock_daily_metrics m
WHERE m.stock_code = '<코드>'
ORDER BY m.trade_date DESC
LIMIT 1;
```

**Step B: Naver Finance에서 실제 종가 가져오기**

WebFetch로 아래 URL 호출 (종목코드 대입):
```
https://finance.naver.com/item/sise_day.naver?code=<코드>&page=1
```
HTML에서 날짜/종가 테이블을 파싱하여 최근 90거래일치 종가 수집.
페이지당 10행이므로 page=1~9 순차 조회하여 63거래일 이전 종가 확보.

KOSPI 지수(코드: KOSPI) 또는 KOSDAQ 지수도 동일하게:
- KOSPI: `https://finance.naver.com/sise/sise_index_day.naver?code=KOSPI&page=1`
- KOSDAQ: `https://finance.naver.com/sise/sise_index_day.naver?code=KOSDAQ&page=1`

**Step C: rsRaw 직접 계산**

```
rsRaw = (현재종가 / 63거래일전종가) / (현재지수 / 63거래일전지수)
```

**Step D: 비교 및 판단**

| 항목 | 값 |
|------|-----|
| Naver 현재종가 | X |
| Naver 63일전종가 | Y |
| 지수 현재 | A |
| 지수 63일전 | B |
| 직접계산 rsRaw | X/Y ÷ A/B |
| 올라 rsRaw | (올라점수) |
| 리스트 rsRaw | (리스트점수) |
| 차이원인 추정 | 63일 기준일 차이 / 종가 기준 차이 / 지수 선택 차이 |

---

## 최종 리포트 형식

```
=== RS 검증 분석 결과 ===

[1] 검증시트O / OllaX (8종목)
- 069540 빛과전자: companies 미등록
- 024850 HLB이노베이션: 정적필터 탈락 (SF2 실패)
...

[2] 검증시트X / OllaO (6종목)
- 215790 이노인스트루먼트: Olla rank=45, rsScore=91 → 외부리스트 기준 다름
...

[3] RS점수 차이 종목
- 046970 우리로
  리스트: 8.9343 / 올라: 8.2129 / 재계산: X.XXXX
  → 원인: 63일 기준일 1일 차이 (리스트는 T-63 영업일, 올라는 캘린더 기준 추정)
...
```
