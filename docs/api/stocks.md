# Stocks API

종목 리스트 조회 - RS(상대강도) 점수 기준 랭킹, 지표, 페이지네이션 지원

## Endpoint

```
GET /real-time-chart/stocks
```

**인증**: 불필요 (`@Public()`)

## Query Parameters

| 파라미터     | 타입   | 필수 | 기본값 | 설명                                              |
| ------------ | ------ | ---- | ------ | ------------------------------------------------- |
| marketType   | string | -    | `'0'`  | 시장 구분 (`'0'`: 전체, `'10'`: 코스피, `'8'`: 코스닥) |
| page         | string | -    | `'1'`  | 페이지 번호 (1부터 시작)                          |
| pageSize     | string | -    | `'50'` | 페이지당 종목 수                                  |

## Response

### 성공 (200 OK)

```json
{
  "marketType": "0",
  "page": 1,
  "pageSize": 50,
  "totalCount": 2400,
  "totalPages": 48,
  "count": 50,
  "stocks": [
    {
      "id": "005930",
      "rank": 1,
      "companyName": "삼성전자",
      "stockCode": "005930",
      "currentPrice": 72000,
      "exchange": "KOSPI",
      "relativeStrengthScore": 95.3,
      "isHighPrice": true,
      "investmentIndicators": "+2.14%",
      "investmentIndicatorsDtl": "-",
      "theme": "반도체",
      "upName": "반도체",
      "rankChange3Days": [1, 2, 3]
    }
  ]
}
```

### Response 필드 설명

#### 페이지네이션

| 필드        | 타입   | 설명                   |
| ----------- | ------ | ---------------------- |
| marketType  | string | 요청한 시장 구분 코드  |
| page        | number | 현재 페이지 번호       |
| pageSize    | number | 페이지당 종목 수       |
| totalCount  | number | 전체 종목 수           |
| totalPages  | number | 전체 페이지 수         |
| count       | number | 현재 페이지 종목 수    |

#### stocks 배열 항목

| 필드                   | 타입     | 설명                                                                 |
| ---------------------- | -------- | -------------------------------------------------------------------- |
| id                     | string   | 종목코드 (6자리)                                                     |
| rank                   | number   | RS 점수 기준 순위                                                    |
| companyName            | string   | 종목명                                                               |
| stockCode              | string   | 종목코드 (6자리)                                                     |
| currentPrice           | number   | 현재가 (최근 일봉 종가 또는 메트릭스 종가)                           |
| exchange               | string   | 거래소 (`"KOSPI"` / `"KOSDAQ"` / 기타)                               |
| relativeStrengthScore  | number   | 상대강도(RS) 점수 (0~100)                                            |
| isHighPrice            | boolean  | 52주 신고가 여부                                                     |
| investmentIndicators   | string   | 전일 대비 등락률 (예: `"+2.14%"`, 데이터 없으면 `"-"`)               |
| investmentIndicatorsDtl| string   | 투자지표 상세 (현재 미사용, `"-"`)                                   |
| theme                  | string   | 업종/테마명 (없으면 `"-"`)                                           |
| upName                 | string   | 업종명 (없으면 `"-"`)                                                |
| rankChange3Days        | number[] | 최근 3거래일간 순위 변동 이력 (최신순, 예: `[1, 2, 3]`)              |

## 내부 동작

### 캐싱

- 종목 리스트는 **시장 구분(marketType) 별로 1시간** 동안 메모리 캐시됨
- 캐시 미스 시 Kiwoom REST API(`ka10099`)를 호출하여 종목 리스트 갱신
- 6자리 숫자 종목코드만 필터 (ETF, ETN 등 제외)

### 데이터 흐름

1. Kiwoom API에서 종목 리스트 조회 (캐시 활용)
2. `stockDailyMetrics` 테이블에서 최신 거래일 지표 조회
3. RS 점수 기준 내림차순 정렬
4. 페이지네이션 적용
5. 해당 페이지 종목들의 최근 종가 및 3일간 순위 변동 이력 조회
6. 병합 후 응답 반환

### 정렬 기준

RS(상대강도) 점수 내림차순. 지표 데이터가 없는 종목은 RS 점수 0으로 처리되어 하위에 위치.

## 사용 예시

### 기본 조회 (전체 시장, 1페이지)

```
GET /real-time-chart/stocks
```

### 코스피 종목만, 2페이지, 20개씩

```
GET /real-time-chart/stocks?marketType=10&page=2&pageSize=20
```

### 코스닥 종목만, 100개씩

```
GET /real-time-chart/stocks?marketType=8&pageSize=100
```

## 관련 엔드포인트

| 엔드포인트                          | 설명                     |
| ----------------------------------- | ------------------------ |
| `POST /real-time-chart/collect/day` | 전체 종목 일봉 데이터 수집 (지표 계산의 원천 데이터) |
| `POST /real-time-chart/metrics/calculate` | 일별 지표 수동 계산 (RS 점수, 순위 등)             |
