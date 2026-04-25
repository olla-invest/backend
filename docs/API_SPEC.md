# API 명세서

> Base URL: `http://localhost:3000`
> 인증: JWT Bearer Token (`Authorization: Bearer <accessToken>`)
> 인증 필요 API: 관심종목, 비밀번호 변경

---

## 0. 인증 `/auth`

### 인증 방식

- 앱 전체에 `JwtAuthGuard` 전역 적용
- `@Public()` 데코레이터가 붙은 엔드포인트는 토큰 없이 접근 가능
- 보호된 엔드포인트는 `Authorization: Bearer <accessToken>` 헤더 필요
- JWT 페이로드: `{ sub: userId, username, email }`
- 토큰 만료: **7일**

---

### 엔드포인트 목록

| Method | Path | 인증 | 설명 |
|--------|------|------|------|
| POST | `/auth/register` | 불필요 | 회원가입 |
| POST | `/auth/login` | 불필요 | 로그인 |
| POST | `/auth/find-id` | 불필요 | 아이디 찾기 |
| POST | `/auth/find-password` | 불필요 | 비밀번호 찾기 (임시 비밀번호 발송) |
| PATCH | `/auth/change-password` | **필요** | 비밀번호 변경 |

---

### POST `/auth/register` — 회원가입

**Request Body**

| 필드 | 타입 | 필수 | 제약 | 설명 |
|------|------|------|------|------|
| `username` | string | ✅ | 4~20자, 영문·숫자만 (`/^[a-zA-Z0-9]{4,20}$/`) | 로그인 ID |
| `password` | string | ✅ | 8~50자 | 비밀번호 |
| `email` | string | ✅ | 이메일 형식, 최대 100자 | 이메일 |
| `name` | string | ✅ | 최대 100자 | 실명 |
| `phone` | string | ✅ | 최대 20자 | 휴대폰 번호 |
| `agreeService` | boolean | ✅ | `true` 이어야 함 | 서비스 이용약관 동의 |
| `agreePrivacy` | boolean | ✅ | `true` 이어야 함 | 개인정보 처리방침 동의 |
| `agreeMarketing` | boolean | ❌ | - | 마케팅 수신 동의 (기본값 `false`) |

**Request 예시**
```json
{
  "username": "user1234",
  "password": "mypassword1!",
  "email": "user@example.com",
  "name": "홍길동",
  "phone": "010-1234-5678",
  "agreeService": true,
  "agreePrivacy": true,
  "agreeMarketing": false
}
```

**Response `201`**
```json
{
  "userId": "uuid-string",
  "username": "user1234",
  "email": "user@example.com",
  "name": "홍길동"
}
```

**에러**

| 상태 | 조건 |
|------|------|
| `400 Bad Request` | 필수 약관 미동의 (`agreeService` 또는 `agreePrivacy`가 `false`) |
| `409 Conflict` | 이미 사용 중인 ID |
| `409 Conflict` | 이미 사용 중인 이메일 |

---

### POST `/auth/login` — 로그인

**Request Body**

| 필드 | 타입 | 필수 | 설명 |
|------|------|------|------|
| `username` | string | ✅ | 로그인 ID |
| `password` | string | ✅ | 비밀번호 |

**Request 예시**
```json
{
  "username": "user1234",
  "password": "mypassword1!"
}
```

**Response `200`**
```json
{
  "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "user": {
    "userId": "uuid-string",
    "username": "user1234",
    "email": "user@example.com",
    "name": "홍길동",
    "isTempPassword": false
  }
}
```

> `isTempPassword: true`이면 로그인 직후 비밀번호 변경 화면으로 안내

**에러**

| 상태 | 조건 |
|------|------|
| `404 Not Found` | 가입된 계정 없음 |
| `401 Unauthorized` | 비밀번호 불일치 |

---

### POST `/auth/find-id` — 아이디 찾기

**Request Body**

| 필드 | 타입 | 필수 | 설명 |
|------|------|------|------|
| `name` | string | ✅ | 실명 |
| `email` | string | ✅ | 가입 이메일 |

**Request 예시**
```json
{
  "name": "홍길동",
  "email": "user@example.com"
}
```

**Response `200`**
```json
{
  "maskedUsername": "user***4"
}
```

> 마스킹 규칙: 앞 4자 + 중간 `*` + 마지막 1자 (4자 이하일 경우 앞 2자 + `*`)

**에러**

| 상태 | 조건 |
|------|------|
| `404 Not Found` | 이름+이메일 일치하는 계정 없음 |

---

### POST `/auth/find-password` — 비밀번호 찾기

임시 비밀번호를 생성하여 가입 이메일로 발송합니다.

**Request Body**

| 필드 | 타입 | 필수 | 설명 |
|------|------|------|------|
| `username` | string | ✅ | 로그인 ID |
| `email` | string | ✅ | 가입 이메일 |

**Request 예시**
```json
{
  "username": "user1234",
  "email": "user@example.com"
}
```

**Response `200`**
```json
{
  "email": "u***@example.com"
}
```

> 임시 비밀번호 발송 후 `isTempPassword` 플래그가 `true`로 설정됨.
> 로그인 후 반드시 비밀번호 변경 필요.

**에러**

| 상태 | 조건 |
|------|------|
| `404 Not Found` | ID+이메일 일치하는 계정 없음 |

---

### PATCH `/auth/change-password` — 비밀번호 변경 🔒

> JWT 토큰 필요

**Request Body**

| 필드 | 타입 | 필수 | 제약 | 설명 |
|------|------|------|------|------|
| `newPassword` | string | ✅ | 8~50자 | 새 비밀번호 |
| `confirmPassword` | string | ✅ | - | 새 비밀번호 확인 (newPassword와 일치해야 함) |

**Request 예시**
```json
{
  "newPassword": "newSecurePass1!",
  "confirmPassword": "newSecurePass1!"
}
```

**Response `200`**
```json
{
  "message": "비밀번호가 변경되었습니다."
}
```

> 성공 시 `isTempPassword`가 `false`로 초기화됨.

**에러**

| 상태 | 조건 |
|------|------|
| `400 Bad Request` | `newPassword`와 `confirmPassword` 불일치 |
| `401 Unauthorized` | 유효하지 않은 토큰 |

---

## 1. 실시간 차트 `/real-time-chart`

### 종목 리스트

| Method | Path | 설명 |
|--------|------|------|
| GET | `/real-time-chart/stocks` | 종목 리스트 (쿼리 파라미터 방식) |
| POST | `/real-time-chart/stocks` | 종목 리스트 (기간 기반 RS 필터) |

**POST `/real-time-chart/stocks` Body**
```json
{
  "marketType": "all",        // "0"(KOSPI) | "10"(KOSDAQ) | "all"
  "page": 1,
  "pageSize": 50,
  "filters": {
    "isHighPrice": true,
    "minTradingValue": 1000000000,
    "theme": [1, 2]
  },
  "rsFilters": [
    { "rsStartDate": "20251001", "rsEndDate": "20260101", "strength": 50 },
    { "rsStartDate": "20260101", "rsEndDate": "20260301", "strength": 50 }
  ]
}
```

**응답 meta**
```json
{
  "dataDate": "2026-03-18",
  "lastUpdatedAt": "2026-03-20T01:46:52.433Z",
  "isInitialized": true,
  "queryStartDate": "2026-10-01",   // 가장 긴 RS 기간의 시작일
  "queryEndDate": "2026-01-01",     // 가장 긴 RS 기간의 종료일
  "rangeRS": { "filters": [...], "periods": [...], "weights": [...] }
}
```

---

### 캔들 차트

| Method | Path | Params | 설명 |
|--------|------|--------|------|
| GET | `/real-time-chart/candles/minute/:stockCode` | `?interval=1` (1,3,5,10,15,30,45,60) | 분봉 |
| GET | `/real-time-chart/candles/tick/:stockCode` | `?interval=1` (1,3,5,10,30) | 틱봉 |
| GET | `/real-time-chart/candles/day/:stockCode` | `?baseDate=YYYYMMDD` | 일봉 |
| GET | `/real-time-chart/candles/week/:stockCode` | `?baseDate=YYYYMMDD` | 주봉 |
| GET | `/real-time-chart/candles/month/:stockCode` | `?baseDate=YYYYMMDD` | 월봉 |

---

### 종목 요약

| Method | Path | 설명 |
|--------|------|------|
| GET | `/real-time-chart/summary/:stockCode` | 현재가, 전일대비, 거래량, 52주 고저 |

---

### 실시간 구독

| Method | Path | Body | 설명 |
|--------|------|------|------|
| POST | `/real-time-chart/realtime/start` | `{ stockCode }` | 단일 종목 구독 시작 |
| POST | `/real-time-chart/realtime/stop` | `{ stockCode }` | 단일 종목 구독 중지 |
| POST | `/real-time-chart/realtime/start-batch` | `{ stockCodes: [] }` | 다수 종목 구독 시작 |
| POST | `/real-time-chart/realtime/stop-batch` | `{ stockCodes: [] }` | 다수 종목 구독 중지 |
| GET | `/real-time-chart/realtime/status` | - | WebSocket 연결 상태 |
| GET | `/real-time-chart/realtime/cache-stats` | - | 실시간 캐시 상태 |

---

### RS 분석

| Method | Path | Body | 설명 |
|--------|------|------|------|
| POST | `/real-time-chart/rs-history/:stockCode` | `{ startDate, endDate, rsFilters }` | 단일 종목 RS 추이 (그래프용) |

---

## 2. 종목 상세 `/real-time-chart/detail`

> 전체 공개 (인증 불필요)

**탭 구성**

| 탭 | API |
|----|-----|
| 차트/시세 | `GET /real-time-chart/detail/chart/:stockCode` |
| 시장강도분석 | `POST /real-time-chart/detail/rs-history/:stockCode` |
| 종목정보 | `GET /real-time-chart/detail/stock-info/:stockCode` |
| 이슈분석 | (미구현) |

---

### GET `/real-time-chart/detail/chart/:stockCode` — 차트/시세 탭

종목 요약(현재가·지표) + 캔들 데이터 + 시세변동현황 테이블을 한 번에 반환합니다.

**Path Parameters**

| 파라미터 | 타입 | 설명 |
|---------|------|------|
| `stockCode` | string | 종목 코드 (6자리) |

**Query Parameters — 차트**

| 파라미터 | 타입 | 기본값 | 설명 |
|---------|------|--------|------|
| `chartType` | string | `day` | 봉 타입: `minute` \| `tick` \| `day` \| `week` \| `month` |
| `interval` | string | `1` | 분/틱 단위 — minute: `1\|3\|5\|10\|15\|30\|45\|60`, tick: `1\|3\|5\|10\|30` |
| `startDate` | string | 전년도 1월 1일 | 차트 시작일 (`YYYYMMDD`, day/week/month에서 사용) |
| `endDate` | string | 오늘 | 차트 종료일 (`YYYYMMDD`) |

**Query Parameters — 시세변동현황 테이블**

| 파라미터 | 타입 | 기본값 | 설명 |
|---------|------|--------|------|
| `historyStartDate` | string | 전년도 1월 1일 | 테이블 시작일 (`YYYYMMDD`) |
| `historyEndDate` | string | 오늘 | 테이블 종료일 (`YYYYMMDD`) |

**Response `200`**

```json
{
  "stockCode": "005930",
  "summary": {
    "currentPrice": 79000,
    "prevDayCompare": 2000,
    "prevDayCompareSign": "2",
    "changeRate": "2.60",
    "volume": "9263135",
    "tradingValue": "731623450000",
    "dayHigh": 79500,
    "dayLow": 78300,
    "week52High": 88800,
    "week52Low": 51800
  },
  "candles": { },
  "priceHistory": {
    "stockCode": "005930",
    "candleType": "day",
    "candles": [
      {
        "time": "2026-02-27T00:00:00.000Z",
        "open": "78800",
        "high": "79500",
        "low": "78300",
        "close": "79000",
        "volume": "9263135",
        "tradingValue": "731623450000",
        "changeRate": "2.54"
      }
    ]
  }
}
```

> `summary`, `candles`, `priceHistory` 중 조회 실패한 항목은 `null` 반환

**summary 필드 설명**

| 필드 | 타입 | 설명 |
|------|------|------|
| `currentPrice` | number | 현재가 |
| `prevDayCompare` | number | 전일 대비 등락폭 |
| `prevDayCompareSign` | string | 부호 (`1`: 상한, `2`: 상승, `3`: 보합, `4`: 하락, `5`: 하한) |
| `changeRate` | string | 등락률 (%) |
| `volume` | string | 거래량 |
| `tradingValue` | string | 거래대금 (원) |
| `dayHigh` | number | 당일 고가 |
| `dayLow` | number | 당일 저가 |
| `week52High` | number | 52주 최고가 |
| `week52Low` | number | 52주 최저가 |

---

**candles 포맷 — `chartType=minute`**

키움 API 직접 호출 (실시간). `tradingValue`, `changeRate` 없음.
가격·거래량은 String 타입, 음수 부호 포함 가능 → `abs()` 처리 필요.

```json
{
  "stockCode": "005930",
  "interval": "60min",
  "candles": [
    {
      "time": "2026-02-27T09:00:00.000Z",
      "open": "78800",
      "high": "78900",
      "low": "78700",
      "close": "78800",
      "volume": "7913"
    }
  ]
}
```

**candles 포맷 — `chartType=tick`**

키움 API 직접 호출 (실시간). `tradingValue`, `changeRate` 없음.
가격·거래량은 String 타입, 음수 부호 포함 가능 → `abs()` 처리 필요.

```json
{
  "stockCode": "005930",
  "interval": "1tick",
  "candles": [
    {
      "time": "2026-02-27T09:00:01.000Z",
      "open": "78800",
      "high": "78900",
      "low": "78700",
      "close": "78800",
      "volume": "500"
    }
  ]
}
```

**candles 포맷 — `chartType=day`**

DB 조회. `tradingValue`, `changeRate`는 null 가능.
모든 값 String 타입.

```json
{
  "stockCode": "005930",
  "candleType": "day",
  "candles": [
    {
      "time": "2026-02-27T00:00:00.000Z",
      "open": "78800",
      "high": "79500",
      "low": "78300",
      "close": "79000",
      "volume": "9263135",
      "tradingValue": "731623450000",
      "changeRate": "2.54"
    }
  ]
}
```

**candles 포맷 — `chartType=week`**

DB 조회 (주봉). 주 시작일(월요일) 기준 time.

```json
{
  "stockCode": "005930",
  "candleType": "week",
  "candles": [
    {
      "time": "2026-02-23T00:00:00.000Z",
      "open": "78400",
      "high": "79500",
      "low": "77500",
      "close": "79000",
      "volume": "56700518",
      "tradingValue": "3922030535087",
      "changeRate": "0.89"
    }
  ]
}
```

**candles 포맷 — `chartType=month`**

DB 조회 (월봉). 월 시작일(1일) 기준 time.

```json
{
  "stockCode": "005930",
  "candleType": "month",
  "candles": [
    {
      "time": "2026-02-01T00:00:00.000Z",
      "open": "78400",
      "high": "80000",
      "low": "77000",
      "close": "79000",
      "volume": "215040968",
      "tradingValue": "15774571011618",
      "changeRate": "1.28"
    }
  ]
}
```

**priceHistory / day·week·month candles 공통 필드**

| 필드 | 타입 | 설명 |
|------|------|------|
| `time` | string (ISO8601 UTC) | 일자 |
| `open` | string | 시가 |
| `high` | string | 고가 |
| `low` | string | 저가 |
| `close` | string | 종가 |
| `volume` | string | 거래량 |
| `tradingValue` | string \| null | 거래대금 |
| `changeRate` | string \| null | 전일 대비 등락률 (%) |

---

### POST `/real-time-chart/detail/rs-history/:stockCode` — 시장강도분석 탭

단일 종목의 날짜별 RS(상대강도) 추이를 반환합니다. 그래프 표시용.

**Path Parameters**

| 파라미터 | 타입 | 설명 |
|---------|------|------|
| `stockCode` | string | 종목 코드 (6자리) |

**Request Body**

| 필드 | 타입 | 필수 | 설명 |
|------|------|------|------|
| `startDate` | string | ✅ | 조회 시작일 (`YYYYMMDD`) |
| `endDate` | string | ❌ | 조회 종료일 (`YYYYMMDD`, 생략 시 오늘) |
| `rsFilters` | array | ❌ | RS 기간 필터 목록 (생략 시 기본 63일 단일 기간) |
| `rsFilters[].rsStartDate` | string | - | RS 기간 시작일 (이전 날짜, `YYYYMMDD`) |
| `rsFilters[].rsEndDate` | string | - | RS 기간 종료일 (이후 날짜, `YYYYMMDD`) |
| `rsFilters[].strength` | number | - | 해당 기간 가중치 (합계 100 권장) |

```json
{
  "startDate": "20250304",
  "endDate": "20260304",
  "rsFilters": [
    { "rsStartDate": "20251001", "rsEndDate": "20260101", "strength": 50 },
    { "rsStartDate": "20260101", "rsEndDate": "20260304", "strength": 50 }
  ]
}
```

**Response `200`**

```json
{
  "stockCode": "005930",
  "indexCode": "INDEX_KOSPI",
  "periods": [92, 62],
  "weights": [50, 50],
  "count": 125,
  "data": [
    { "date": "20250304", "rsRaw": 1.023456 },
    { "date": "20250305", "rsRaw": 1.031234 }
  ]
}
```

**응답 필드 설명**

| 필드 | 타입 | 설명 |
|------|------|------|
| `indexCode` | string | 비교 지수 코드 (`INDEX_KOSPI` \| `INDEX_KOSDAQ`) |
| `periods` | number[] | rsFilters에서 계산된 기간(달력일) 배열 |
| `weights` | number[] | 각 기간 가중치 배열 |
| `count` | number | 반환 데이터 포인트 수 |
| `data[].date` | string | 거래일 (`YYYYMMDD`) |
| `data[].rsRaw` | number | 가중 평균 RS 원값 (1.0 기준, 1 이상이면 시장 대비 강세) |

---

### GET `/real-time-chart/detail/stock-info/:stockCode` — 종목정보 탭

DART 기업개황·손익현황·현금흐름·재무지표를 통합 조회합니다.

**Path Parameters**

| 파라미터 | 타입 | 설명 |
|---------|------|------|
| `stockCode` | string | 종목 코드 (6자리) |

**Query Parameters**

| 파라미터 | 타입 | 기본값 | 설명 |
|---------|------|--------|------|
| `year` | string | 전년도 (`YYYY-1`) | 사업연도 (예: `2025`) |

**Response `200`**

```json
{
  "stockCode": "005930",
  "overview": {
    "stockCode": "005930",
    "corpCode": "00126380",
    "corpName": "삼성전자",
    "corpNameEng": "SAMSUNG ELECTRONICS CO,.LTD",
    "ceoName": "한종희",
    "corpClass": "Y",
    "industryCode": "264",
    "establishedDate": "19690113",
    "settlementMonth": "12",
    "address": "경기도 수원시 영통구 삼성로 129",
    "homepage": "www.samsung.com/sec",
    "phone": "031-200-1114"
  },
  "income": {
    "stockCode": "005930",
    "year": "2025",
    "fsDiv": "CFS",
    "revenue":         { "q1": 79100000000000, "q2": 74000000000000, "q3": 79100000000000, "q4": 80000000000000 },
    "operatingIncome": { "q1":  6600000000000, "q2":  8300000000000, "q3": 10000000000000, "q4":  9000000000000 },
    "netIncome":       { "q1":  5800000000000, "q2":  6900000000000, "q3":  7700000000000, "q4":  8000000000000 }
  },
  "cashFlow": {
    "stockCode": "005930",
    "year": "2025",
    "operatingCashFlow":  { "q1": 12000000000000, "q2": 11000000000000, "q3": 13000000000000, "q4": 14000000000000 },
    "investingCashFlow":  { "q1": -8000000000000, "q2": -7000000000000, "q3": -9000000000000, "q4": -9500000000000 },
    "financingCashFlow":  { "q1": -2000000000000, "q2": -3000000000000, "q3": -2500000000000, "q4": -3000000000000 }
  },
  "indicators": {
    "stockCode": "005930",
    "year": "2025",
    "q1": {
      "profitability": { "매출액순이익률": "7.33", "ROE(%)": "8.12" },
      "stability":     { "부채비율(%)": "34.50", "유동비율(%)": "210.30" },
      "activity":      { "총자산회전율(회)": "0.52" }
    },
    "q2": { "profitability": {}, "stability": {}, "activity": {} },
    "q3": { "profitability": {}, "stability": {}, "activity": {} },
    "q4": { "profitability": {}, "stability": {}, "activity": {} }
  }
}
```

> `overview`, `income`, `cashFlow`, `indicators` 각 항목은 DART 조회 실패 시 `null` 반환

**overview 필드 설명**

| 필드 | 타입 | 설명 |
|------|------|------|
| `corpCode` | string | DART 고유번호 |
| `corpClass` | string | 법인 구분 (`Y`: 유가증권, `K`: 코스닥, `N`: 코넥스) |
| `industryCode` | string | 업종 코드 |
| `establishedDate` | string | 설립일 (`YYYYMMDD`) |
| `settlementMonth` | string | 결산월 (`MM`) |

**income / cashFlow 분기 필드**

| 필드 | 타입 | 설명 |
|------|------|------|
| `fsDiv` | string | 재무제표 구분 (`CFS`: 연결, `OFS`: 별도) |
| `q1` / `q2` / `q3` / `q4` | number \| null | 분기 단독 금액 (원, 누적 차분 환산) |

> Q2~Q4는 누적 보고서 차분으로 standalone 환산한 값입니다.

**indicators 분기 필드**

| 필드 | 타입 | 설명 |
|------|------|------|
| `profitability` | object | 수익성 지표 (매출액순이익률, ROE 등) |
| `stability` | object | 안정성 지표 (부채비율, 유동비율 등) |
| `activity` | object | 활동성 지표 (총자산회전율 등) |

> 지표 키는 DART 원문 항목명 그대로 사용. 각 분기 보고서 원본값으로 누적 차분 없음.

**에러**

| 상태 | 조건 |
|------|------|
| `404 Not Found` | 존재하지 않는 종목 코드 |
| `404 Not Found` | DART 고유번호 미등록 (sync-corp-codes 미실행) |

---

## 3. 이슈 테마 `/issue-theme`

> 전체 공개 (인증 불필요)

### 엔드포인트 목록

| Method | Path | 설명 |
|--------|------|------|
| GET | `/issue-theme` | 테마 목록 (상승비율 내림차순) |
| GET | `/issue-theme/:themeCode` | 테마 상세 팝업 |
| POST | `/issue-theme/sync-themes` | 테마 마스터 동기화 (최초 1회) |
| POST | `/issue-theme/snapshot/theme` | 테마 일별 스냅샷 저장 (장 마감 후) |
| POST | `/issue-theme/snapshot/trading-value` | 거래대금 스냅샷 저장 (10분 단위) |

---

### GET `/issue-theme` — 테마 목록

**Query Parameters**

| 파라미터 | 타입 | 기본값 | 설명 |
|---------|------|--------|------|
| `display` | number | `20` | 페이지당 항목 수 |
| `page` | number | `1` | 페이지 번호 |

> 종목 필터 기준: 정적 필터(passedStaticFilters=true) + 동적 필터(DF1·DF2·DF3) 통과 종목만 집계
> - DF1: `현재가 >= 52주 저가 × 1.3`
> - DF2: `현재가 >= 52주 고가 × 0.75`
> - DF3: `현재가 > 50일 이동평균`

**Response `200`**
```json
{
  "updatedAt": "2026-03-20T09:30:00.000Z",
  "total": 19,
  "page": 1,
  "display": 20,
  "themes": [
    {
      "themeCode": 5,
      "themeName": "건설",
      "rank": 1,
      "rankChange": 2,
      "totalCount": 12,
      "risingCount": 9,
      "risingRatio": 75.0,
      "avgChangeRate": 2.34
    }
  ]
}
```

**응답 필드 설명**

| 필드 | 타입 | 설명 |
|------|------|------|
| `updatedAt` | ISO string | 응답 생성 시각 |
| `total` | number | 전체 테마 수 |
| `page` | number | 현재 페이지 |
| `display` | number | 페이지당 항목 수 |
| `themes[].themeCode` | number | 테마 코드 |
| `themes[].themeName` | string | 테마명 |
| `themes[].rank` | number | 현재 순위 (상승비율 기준, 동률 동일 순위) |
| `themes[].rankChange` | number \| null | 순위 변동 (전일 순위 - 현재 순위, 양수=상승) |
| `themes[].totalCount` | number | 필터 통과 종목 수 |
| `themes[].risingCount` | number | 상승 종목 수 (등락률 > 0) |
| `themes[].risingRatio` | number | 상승 비율 (%) |
| `themes[].avgChangeRate` | number | 평균 등락률 (%) |

---

### GET `/issue-theme/:themeCode` — 테마 상세

**Path Parameters**

| 파라미터 | 타입 | 설명 |
|---------|------|------|
| `themeCode` | number | 테마 코드 |

**Response `200`**
```json
{
  "themeCode": 5,
  "themeName": "건설",
  "rank": 1,
  "rankChange": 2,
  "risingCount": 9,
  "totalCount": 12,
  "insights": [
    "테마 내 상승 종목 비율 증가",
    "거래대금 급증 종목 증가"
  ],
  "stocks": [
    {
      "rank": 1,
      "stockCode": "000720",
      "companyName": "현대건설",
      "currentPrice": 45000,
      "changeRate": 3.45,
      "rsScore": 92.5,
      "tradingValueRatio": "2.3배"
    }
  ],
  "updatedAt": "2026-03-20T09:30:00.000Z"
}
```

**응답 필드 설명**

| 필드 | 타입 | 설명 |
|------|------|------|
| `rank` | number \| null | 당일 스냅샷 기준 순위 (스냅샷 없으면 null) |
| `rankChange` | number \| null | 전일 대비 순위 변동 |
| `insights` | string[] | 인사이트 문구 목록 (아래 참고) |
| `stocks[].rank` | number | RS점수 기준 종목 순위 |
| `stocks[].rsScore` | number | 상대강도 점수 |
| `stocks[].tradingValueRatio` | string | 전일 동시간 대비 거래대금 배율 (예: `"2.3배"`, 비교 불가 시 `"-"`) |

**인사이트 발생 조건**

| 문구 | 조건 |
|------|------|
| `테마 내 상승 종목 비율 증가` | 전일 대비 상승비율 10%p 이상 증가 AND 상승비율 ≥ 50% |
| `거래대금 급증 종목 증가` | 전일 동시간 대비 거래대금 2배 이상인 종목이 전일보다 2개 이상 증가 |
| `평균 등락률 상승` | 테마 평균 등락률 ≥ 2% |
| `상위 종목 급등` | 테마 내 등락률 ≥ 7%인 종목 존재 |

**에러**

| 상태 | 조건 |
|------|------|
| `404 Not Found` | 존재하지 않는 themeCode |

---

### POST `/issue-theme/sync-themes` — 테마 마스터 동기화

키움 API 종목 리스트의 `upName` 필드를 기반으로 테마 마스터 데이터를 동기화합니다.
최초 1회 또는 테마 데이터 갱신 시 수동 호출.

**Response `201`**
```json
{
  "themesCreated": 3,
  "companiesUpdated": 142
}
```

---

### POST `/issue-theme/snapshot/theme` — 테마 일별 스냅샷 저장

장 마감 후 1회 호출. 당일 테마 순위·지표를 DB에 저장합니다.

**Response `201`**
```json
{
  "saved": 19,
  "date": "2026-03-20"
}
```

---

### POST `/issue-theme/snapshot/trading-value` — 거래대금 스냅샷 저장

장중 10분 단위로 호출. 실시간 캐시의 누적 거래대금을 DB에 저장합니다.

**Response `201`**
```json
{
  "saved": 312,
  "time": "1030"
}
```

---

## 4. 관심종목 `/watchlist` 🔒

> 모든 엔드포인트에 JWT 인증 필요 (`Authorization: Bearer <accessToken>`)

### 엔드포인트 목록

| Method | Path | 설명 |
|--------|------|------|
| GET | `/watchlist/stocks` | 관심종목 현황 조회 (지표 + 이벤트) |
| POST | `/watchlist/stocks` | 관심종목 추가 |
| DELETE | `/watchlist/stocks/:stockCode` | 관심종목 삭제 |

---

### GET `/watchlist/stocks` — 관심종목 현황 조회

로그인 사용자의 관심종목 목록과 최신 거래일 기준 지표를 반환합니다.

**Response `200`**
```json
{
  "tradeDate": "2026-03-18T00:00:00.000Z",
  "stocks": [
    {
      "companyId": "123456",
      "stockCode": "005930",
      "companyName": "삼성전자",
      "marketType": "KOSPI",
      "addedDate": "2026-03-01T00:00:00.000Z",
      "memo": null,
      "closePrice": 72000,
      "priceChange1d": 900,
      "priceChangeRate1d": 1.27,
      "rank": 42,
      "prevRank": 50,
      "relativeStrengthScore": 87.5,
      "isNewHigh": false,
      "events": ["RANK_UP"]
    }
  ]
}
```

**응답 필드 설명**

| 필드 | 타입 | 설명 |
|------|------|------|
| `tradeDate` | Date \| null | 최신 거래일 (데이터 없으면 null) |
| `stocks[].companyId` | string | 종목 고유 ID (bigint) |
| `stocks[].stockCode` | string | 종목 코드 (6자리) |
| `stocks[].companyName` | string | 종목명 |
| `stocks[].marketType` | string | 시장 구분 (`KOSPI` / `KOSDAQ`) |
| `stocks[].addedDate` | Date | 관심종목 등록일 |
| `stocks[].memo` | string \| null | 메모 |
| `stocks[].closePrice` | number \| null | 종가 |
| `stocks[].priceChange1d` | number \| null | 전일 대비 가격 변동 |
| `stocks[].priceChangeRate1d` | number \| null | 전일 대비 등락률 (%) |
| `stocks[].rank` | number \| null | 당일 RS 순위 |
| `stocks[].prevRank` | number \| null | 전일 RS 순위 |
| `stocks[].relativeStrengthScore` | number \| null | RS 점수 |
| `stocks[].isNewHigh` | boolean | 신고가 여부 |
| `stocks[].events` | string[] | 이벤트 목록 (아래 참고) |

**이벤트 종류**

| 값 | 조건 |
|----|------|
| `NEW_HIGH` | 당일 신고가 달성 (`isNewHigh = true`) |
| `RANK_UP` | 전일 대비 순위 상승 (`rank < prevRank`) |
| `RANK_DOWN` | 전일 대비 순위 하락 (`rank > prevRank`) |

**에러**

| 상태 | 조건 |
|------|------|
| `401 Unauthorized` | 토큰 없음 또는 만료 |

---

### POST `/watchlist/stocks` — 관심종목 추가

**Request Body**

| 필드 | 타입 | 필수 | 설명 |
|------|------|------|------|
| `stockCode` | string | ✅ | 종목 코드 (6자리) |

```json
{
  "stockCode": "005930"
}
```

**Response `201`**
```json
{
  "userId": "uuid-string",
  "companyId": "123456",
  "addedDate": "2026-03-20T09:00:00.000Z",
  "deletedAt": null,
  "memo": null,
  "company": {
    "stockCode": "005930",
    "companyName": "삼성전자",
    "marketType": "KOSPI"
  }
}
```

> 이전에 삭제한 종목을 재추가하면 soft delete 복구 처리 (신규 생성 아님)

**에러**

| 상태 | 조건 |
|------|------|
| `401 Unauthorized` | 토큰 없음 또는 만료 |
| `404 Not Found` | 존재하지 않는 종목 코드 |
| `409 Conflict` | 이미 관심종목으로 등록된 종목 |

---

### DELETE `/watchlist/stocks/:stockCode` — 관심종목 삭제

**Path Parameters**

| 파라미터 | 타입 | 설명 |
|---------|------|------|
| `stockCode` | string | 삭제할 종목 코드 (6자리) |

**Response `200`**
```json
{
  "message": "관심종목에서 삭제되었습니다",
  "stockCode": "005930"
}
```

> Soft delete 처리 (DB에서 완전 삭제되지 않고 `deletedAt` 시각만 기록됨)

**에러**

| 상태 | 조건 |
|------|------|
| `401 Unauthorized` | 토큰 없음 또는 만료 |
| `404 Not Found` | 존재하지 않는 종목 코드 |
| `404 Not Found` | 관심종목에 등록되지 않은 종목 |

---

## 5. 종목 정보 `/stock-info` (DART)

| Method | Path | Params | 설명 |
|--------|------|--------|------|
| GET | `/stock-info/:stockCode/overview` | - | 기업개황 |
| GET | `/stock-info/:stockCode/income` | `?year=YYYY` | 손익현황 (분기별) |
| GET | `/stock-info/:stockCode/cash-flow` | `?year=YYYY` | 현금흐름 (분기별) |
| GET | `/stock-info/:stockCode/indicators` | `?year=YYYY` | 재무지표 (수익성/안정성/활동성) |
| GET | `/stock-info/:stockCode/news` | `?display=10&sort=date&start=1` | 네이버 뉴스 |
| GET | `/stock-info/:stockCode/stockInfo` | `?year=YYYY` | 위 4개 통합 조회 |
| POST | `/stock-info/sync-corp-codes` | - | DART 고유번호 동기화 (최초 1회) |

---

## 6. 관리용 엔드포인트

> 수동 배치 실행용. 스케줄러가 자동 실행하나 필요 시 직접 호출.

| Method | Path | Body | 설명 |
|--------|------|------|------|
| POST | `/real-time-chart/collect/day` | `{ "marketType": "0", "days": 3 }` | 일봉 수집 |
| POST | `/real-time-chart/collect/index` | - | 지수 일봉 수집 |
| POST | `/real-time-chart/collect/index-close` | - | 오늘 지수 종가 수집 |
| POST | `/real-time-chart/metrics/calculate` | `{ "marketType": "all" }` | RS·메트릭 계산 |
| POST | `/real-time-chart/initialize` | `{ "marketTypes": ["0","10"] }` | 데이터 초기화 |
| GET | `/real-time-chart/status` | - | 초기화 상태 확인 |

---

## 스케줄러 (자동 실행)

| 시각 (KST) | 작업 |
|-----------|------|
| 월~금 08:50 | 장 시작 전 데이터 준비 + 실시간 연결 확인 |
| 월~금 09:00~15:30 (3분마다) | 장중 RS·메트릭 재계산 |
| 월~금 15:40 | 장 마감 후 일봉 수집 + 메트릭 계산 |
| 매일 00:10 | 일별 유지보수 |
