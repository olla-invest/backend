# 📘 Real-Time Chart API 문서 (프론트엔드용)

## 1. 종목 리스트 조회 (메인 엔드포인트)

**`GET /real-time-chart/stocks`**

종목 리스트를 RS 점수 순으로 정렬하여 조회합니다. 페이지네이션과 필터링을 지원합니다.

### 요청 파라미터

| 파라미터           | 타입    | 필수 | 기본값 | 설명                                             |
|-------------------|---------|------|--------|-------------------------------------------------|
| marketType        | string  | X    | "0"    | 시장 타입 ("0": KOSPI, "10": KOSDAQ, "8": ETF)   |
| page              | number  | X    | 1      | 페이지 번호                                      |
| pageSize          | number  | X    | 50     | 페이지당 종목 수                                 |
| isHighPrice       | boolean | X    | -      | 신고가 필터 (true: 신고가 종목만)                 |
| minTradingValue   | number  | X    | -      | 최소 거래대금 필터 (단위: 원)                     |
| rsPeriods         | string  | X    | -      | 커스텀 RS 기간 (쉼표 구분, 예: "63,126,252")      |
| rsWeights         | string  | X    | -      | 커스텀 RS 가중치 (쉼표 구분, 예: "50,30,20")      |

### 응답 형식

```json
{
  "marketType": "0",
  "page": 1,
  "pageSize": 50,
  "totalCount": 84,
  "totalPages": 2,
  "count": 50,
  "meta": {
    "dataDate": "2026-02-08",
    "lastUpdatedAt": "2026-02-09T07:41:05.473Z",
    "isInitialized": true
  },
  "stocks": [
    {
      "id": "005930",
      "rank": 1,
      "companyName": "삼성전자",
      "stockCode": "005930",
      "currentPrice": 71500,
      "exchange": "KOSPI",
      "relativeStrengthScore": 95,
      "isHighPrice": true,
      "investmentIndicators": "+3.24%",
      "investmentIndicatorsDtl": "-",
      "theme": "반도체",
      "upName": "IT",
      "rankHistory": {
        "today": 1,
        "oneDayAgo": 2,
        "twoDaysAgo": 3
      }
    }
  ]
}
```

### 사용 예시

**1. 기본 조회 (KOSPI, 첫 페이지)**
```bash
curl "http://localhost:3000/real-time-chart/stocks?marketType=0&page=1&pageSize=50"
```

**2. KOSDAQ 조회**
```bash
curl "http://localhost:3000/real-time-chart/stocks?marketType=10&page=1&pageSize=50"
```

**3. 신고가 종목만 조회**
```bash
curl "http://localhost:3000/real-time-chart/stocks?marketType=0&isHighPrice=true"
```

**4. 거래대금 10억 이상 필터**
```bash
curl "http://localhost:3000/real-time-chart/stocks?marketType=0&minTradingValue=1000000000&pageSize=50"
```

**5. 거래대금 1000억 이상 (대형주)**
```bash
curl "http://localhost:3000/real-time-chart/stocks?marketType=0&minTradingValue=100000000000&pageSize=50"
```

**6. 복합 필터 (신고가 + 거래대금)**
```bash
curl "http://localhost:3000/real-time-chart/stocks?marketType=0&isHighPrice=true&minTradingValue=1000000000"
```

**7. 커스텀 RS 조회 (3개 기간 조합)**
```bash
curl "http://localhost:3000/real-time-chart/stocks?marketType=0&rsPeriods=63,126,252&rsWeights=50,30,20&pageSize=50"
```

---

## 2. 시스템 상태 조회

**`GET /real-time-chart/status`**

데이터 초기화 상태 및 마지막 업데이트 시간을 확인합니다.

### 요청 파라미터
없음

### 응답 형식

```json
{
  "initialized": true,
  "lastUpdate": "2026-02-09T07:41:05.473Z",
  "message": "Data initialization completed"
}
```

### 사용 예시

```bash
curl "http://localhost:3000/real-time-chart/status"
```

---

## 주요 필터 조합 예시

### 거래대금 기준
- 10억 이상: `minTradingValue=1000000000`
- 100억 이상: `minTradingValue=10000000000`
- 1000억 이상: `minTradingValue=100000000000` (대형주)

### 시장 구분
- KOSPI: `marketType=0`
- KOSDAQ: `marketType=10`
- ETF: `marketType=8`

### 신고가 여부
- 신고가만: `isHighPrice=true`
- 전체: 파라미터 생략
