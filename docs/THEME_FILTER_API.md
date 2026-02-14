# 테마(업종) 필터 API 가이드

## 개요

종목 리스트 조회 API에 테마(업종) 필터링 기능이 추가되었습니다.
이 기능을 사용하면 특정 업종에 속한 종목만 조회할 수 있습니다.

**테마 코드는 숫자 형식을 사용합니다.**

## 테마 코드 목록

| 코드 | 테마명 | 설명 |
|------|--------|------|
| `0` | 전체 | 모든 업종 |
| `100` | 제조업 | 제조업 전반 (제약, 금속, 건설, 자동차, 전자, 화학, 음식료, 섬유, 기계 등) |
| `200` | 서비스업 | 서비스업 전반 (유통, 통신, 에너지, 미디어, 여행, 교육, 의료 등) |
| `300` | IT/기술 | IT 및 기술 산업 (소프트웨어, 반도체, 바이오, 게임 등) |
| `400` | 금융 | 금융업 (은행, 증권, 보험 등) |
| `500` | 운송/물류 | 운송 및 물류업 (해운, 항공, 물류 등) |
| `900` | 기타 | 기타 업종 |

### 복수 테마 필터링

**여러 테마를 동시에 필터링할 수 있습니다:**

- **GET 방식**: 쉼표로 구분된 문자열 사용
  - 예: `theme=100,200` (제조업, 서비스업)

- **POST 방식**: 숫자 배열 사용
  - 예: `"theme": [100, 200]` (제조업, 서비스업)

- **0 코드**: `0`이 포함되면 모든 업종을 허용합니다
  - 예: `theme=0` 또는 `"theme": [0]` = 전체 업종

**사용 예시**:
- 제조업과 IT/기술: `theme=100,300`
- 금융과 서비스업: `theme=200,400`
- 단일 테마: `theme=100` 또는 `"theme": [100]` (제조업만)

## API 사용법

### 1. GET 엔드포인트 (쿼리 파라미터)

**엔드포인트**: `GET /real-time-chart/stocks`

**쿼리 파라미터**:
- `marketType`: 시장 타입 (`'0'` = KOSPI, `'10'` = KOSDAQ, `'8'` = ETF)
- `page`: 페이지 번호 (기본값: 1)
- `pageSize`: 페이지 크기 (기본값: 50)
- `isHighPrice`: 신고가 여부 (`'true'` | `'false'`)
- `minTradingValue`: 최소 거래대금
- **`theme`**: 테마 코드 (쉼표로 구분, 예: `"100"`, `"100,200,300"` 등)
  - 단일 테마: `theme=100` (제조업만)
  - 복수 테마: `theme=100,200,300` (제조업, 서비스업, IT/기술)
- `rsPeriods`: RS 계산 기간
- `rsWeights`: RS 가중치
- `rsDates`: RS 계산 날짜

**예시**:

```bash
# 제조업 종목만 조회
curl "http://localhost:3000/real-time-chart/stocks?marketType=0&theme=100"

# 제조업, 서비스업, IT/기술 업종 종목 조회 (복수 테마)
curl "http://localhost:3000/real-time-chart/stocks?marketType=0&theme=100,200,300"

# IT/기술 업종 + 신고가 종목만 조회
curl "http://localhost:3000/real-time-chart/stocks?marketType=0&theme=300&isHighPrice=true"

# 금융 업종 + 최소 거래대금 1억원 이상
curl "http://localhost:3000/real-time-chart/stocks?marketType=0&theme=400&minTradingValue=100000000"

# 제조업, IT/기술 업종 + 신고가 종목
curl "http://localhost:3000/real-time-chart/stocks?marketType=0&theme=100,300&isHighPrice=true"
```

**JavaScript 예시**:

```javascript
// Axios 사용 - 단일 테마
const response = await axios.get('/real-time-chart/stocks', {
  params: {
    marketType: '0',
    page: 1,
    pageSize: 50,
    theme: '100',  // 제조업만
    isHighPrice: 'true'
  }
});

// Axios 사용 - 복수 테마
const response = await axios.get('/real-time-chart/stocks', {
  params: {
    marketType: '0',
    page: 1,
    pageSize: 50,
    theme: '100,200,300',  // 제조업, 서비스업, IT/기술
    isHighPrice: 'true'
  }
});

// Fetch 사용
const params = new URLSearchParams({
  marketType: '0',
  theme: '300',  // IT/기술
  minTradingValue: '100000000'
});

const response = await fetch(`/real-time-chart/stocks?${params}`);
const data = await response.json();
```

### 2. POST 엔드포인트 (Body 파라미터)

**엔드포인트**: `POST /real-time-chart/stocks`

**Request Body**:

```json
{
  "marketType": "0",
  "page": 1,
  "pageSize": 50,
  "filters": {
    "isHighPrice": true,
    "minTradingValue": 100000000,
    "theme": [100, 200, 300]
  },
  "rsFilters": [
    { "rsStartDate": "2026-02-09", "rsEndDate": "2026-01-15", "strength": 50 },
    { "rsStartDate": "2026-01-15", "rsEndDate": "2025-12-01", "strength": 30 },
    { "rsStartDate": "2025-12-01", "rsEndDate": "2025-11-10", "strength": 20 }
  ]
}
```

**필터 옵션**:

| 필드 | 타입 | 설명 | 예시 |
|------|------|------|------|
| `isHighPrice` | boolean | 신고가 여부 | `true` |
| `minTradingValue` | number | 최소 거래대금 | `100000000` (1억원) |
| **`theme`** | number[] | 테마 코드 배열 | `[100]` (제조업만), `[100, 200, 300]` (제조업, 서비스업, IT/기술) |

**예시**:

```bash
# 제조업 + 신고가 종목 조회 (단일 테마)
curl -X POST http://localhost:3000/real-time-chart/stocks \
  -H "Content-Type: application/json" \
  -d '{
    "marketType": "0",
    "page": 1,
    "pageSize": 50,
    "filters": {
      "theme": [100],
      "isHighPrice": true
    }
  }'

# 제조업, 서비스업, IT/기술 업종 + 신고가 종목 조회 (복수 테마)
curl -X POST http://localhost:3000/real-time-chart/stocks \
  -H "Content-Type: application/json" \
  -d '{
    "marketType": "0",
    "page": 1,
    "pageSize": 50,
    "filters": {
      "theme": [100, 200, 300],
      "isHighPrice": true
    }
  }'

# IT/기술 업종 + 기간별 RS 필터
curl -X POST http://localhost:3000/real-time-chart/stocks \
  -H "Content-Type: application/json" \
  -d '{
    "marketType": "0",
    "filters": {
      "theme": [300],
      "minTradingValue": 100000000
    },
    "rsFilters": [
      { "rsStartDate": "2026-02-09", "rsEndDate": "2026-01-15", "strength": 50 }
    ]
  }'
```

**JavaScript 예시**:

```javascript
// Axios 사용 - 단일 테마
const response = await axios.post('/real-time-chart/stocks', {
  marketType: '0',
  page: 1,
  pageSize: 50,
  filters: {
    theme: [100],  // 제조업만
    isHighPrice: true,
    minTradingValue: 100000000
  }
});

// Axios 사용 - 복수 테마
const response = await axios.post('/real-time-chart/stocks', {
  marketType: '0',
  page: 1,
  pageSize: 50,
  filters: {
    theme: [100, 200, 300],  // 제조업, 서비스업, IT/기술
    isHighPrice: true,
    minTradingValue: 100000000
  }
});

// Fetch 사용
const response = await fetch('/real-time-chart/stocks', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    marketType: '0',
    filters: {
      theme: [300]  // IT/기술만
    }
  })
});
```

## 응답 형식

응답에는 기존과 동일하게 종목 정보가 포함되며, 각 종목에는 `theme`와 `upName` 필드가 있습니다:

```json
{
  "marketType": "0",
  "totalCount": 25,
  "totalPages": 1,
  "currentPage": 1,
  "pageSize": 50,
  "stocks": [
    {
      "stockCode": "000100",
      "stockName": "유한양행",
      "theme": "제약",
      "upName": "제약",
      "rsScore": 85.5,
      "rank": 10,
      "currentPrice": 50000,
      "priceChange": 1000,
      "priceChangeRate": 2.04,
      "tradingValue": 150000000,
      "isHighPrice": true
    }
  ]
}
```

## 주요 필드 설명

- **`theme`**: 테마명 (키움 API의 `upName` 값)
- **`upName`**: 키움 API 원본 업종명
- 필터링은 `upName` 값을 우리의 숫자 테마 코드로 매핑하여 수행됩니다

## 테마 매칭 로직

키움 API의 `upName` 값은 다양한 형식으로 제공되므로, 부분 매칭을 통해 테마 범위로 분류합니다:

- "제약", "의약", "금속", "철강", "건설", "자동차", "전기", "전자", "화학" 등 → `100` (제조업)
- "유통", "서비스", "통신", "에너지", "미디어", "여행", "교육", "의료" 등 → `200` (서비스업)
- "소프트웨어", "IT", "반도체", "디스플레이", "바이오", "게임" 등 → `300` (IT/기술)
- "금융", "은행", "증권", "보험" 등 → `400` (금융)
- "해운", "항공", "물류", "운송" 등 → `500` (운송/물류)
- 그 외 → `900` (기타)

## 프론트엔드 구현 예시

### React 예시

```typescript
import { useState, useEffect } from 'react';
import axios from 'axios';

const THEME_CODES = [
  { code: 0, name: '전체' },
  { code: 100, name: '제조업' },
  { code: 200, name: '서비스업' },
  { code: 300, name: 'IT/기술' },
  { code: 400, name: '금융' },
  { code: 500, name: '운송/물류' },
  { code: 900, name: '기타' },
];

function StockList() {
  const [selectedTheme, setSelectedTheme] = useState(0);
  const [stocks, setStocks] = useState([]);

  useEffect(() => {
    const fetchStocks = async () => {
      const response = await axios.get('/real-time-chart/stocks', {
        params: {
          marketType: '0',
          theme: selectedTheme !== 0 ? selectedTheme : undefined
        }
      });
      setStocks(response.data.stocks);
    };

    fetchStocks();
  }, [selectedTheme]);

  return (
    <div>
      <select
        value={selectedTheme}
        onChange={(e) => setSelectedTheme(Number(e.target.value))}
      >
        {THEME_CODES.map(theme => (
          <option key={theme.code} value={theme.code}>
            {theme.name}
          </option>
        ))}
      </select>

      <ul>
        {stocks.map(stock => (
          <li key={stock.stockCode}>
            {stock.stockName} ({stock.theme}) - RS: {stock.rsScore}
          </li>
        ))}
      </ul>
    </div>
  );
}
```

### Vue 예시

```vue
<template>
  <div>
    <select v-model="selectedTheme" @change="fetchStocks">
      <option v-for="theme in THEME_CODES" :key="theme.code" :value="theme.code">
        {{ theme.name }}
      </option>
    </select>

    <ul>
      <li v-for="stock in stocks" :key="stock.stockCode">
        {{ stock.stockName }} ({{ stock.theme }}) - RS: {{ stock.rsScore }}
      </li>
    </ul>
  </div>
</template>

<script>
import axios from 'axios';

export default {
  data() {
    return {
      selectedTheme: 0,
      stocks: [],
      THEME_CODES: [
        { code: 0, name: '전체' },
        { code: 101, name: '제약' },
        { code: 102, name: '금속' },
        { code: 302, name: '반도체' },
        // ...
      ]
    };
  },
  methods: {
    async fetchStocks() {
      const response = await axios.get('/real-time-chart/stocks', {
        params: {
          marketType: '0',
          theme: this.selectedTheme !== 0 ? this.selectedTheme : undefined
        }
      });
      this.stocks = response.data.stocks;
    }
  },
  mounted() {
    this.fetchStocks();
  }
};
</script>
```

## 테마 코드 TypeScript 타입

프론트엔드에서 사용할 TypeScript 타입 정의:

```typescript
export type ThemeCode =
  | 0    // 전체
  | 101  // 제약
  | 102  // 금속
  | 103  // 건설
  | 104  // 운송장비/부품
  | 105  // 전기/전자
  | 106  // 화학
  | 107  // 음식료
  | 108  // 섬유
  | 109  // 종이
  | 110  // 기계
  | 111  // 화장품
  | 201  // 유통
  | 202  // 서비스
  | 203  // 통신
  | 204  // 에너지
  | 205  // 엔터테인먼트
  | 206  // 여행/레저
  | 207  // 교육
  | 208  // 의료
  | 301  // IT/소프트웨어
  | 302  // 반도체
  | 303  // 바이오
  | 304  // 게임
  | 401  // 금융
  | 501  // 해운
  | 502  // 항공
  | 503  // 방산
  | 999; // 기타

export interface ThemeInfo {
  code: ThemeCode;
  name: string;
  description?: string;
}

export const THEME_CODES: ThemeInfo[] = [
  { code: 0, name: '전체', description: '모든 업종' },
  { code: 101, name: '제약', description: '의약품' },
  { code: 102, name: '금속', description: '철강/금속' },
  { code: 103, name: '건설', description: '건설업' },
  { code: 104, name: '운송장비/부품', description: '자동차 및 부품' },
  { code: 105, name: '전기/전자', description: '전기전자' },
  { code: 106, name: '화학', description: '화학' },
  { code: 107, name: '음식료', description: '음식료품' },
  { code: 108, name: '섬유', description: '섬유/의복' },
  { code: 109, name: '종이', description: '종이/목재' },
  { code: 110, name: '기계', description: '기계' },
  { code: 111, name: '화장품', description: '화장품' },
  { code: 201, name: '유통', description: '유통업' },
  { code: 202, name: '서비스', description: '서비스업' },
  { code: 203, name: '통신', description: '통신업' },
  { code: 204, name: '에너지', description: '전기/가스' },
  { code: 205, name: '엔터테인먼트', description: '미디어/엔터' },
  { code: 206, name: '여행/레저', description: '여행/레저' },
  { code: 207, name: '교육', description: '교육서비스' },
  { code: 208, name: '의료', description: '의료/헬스케어' },
  { code: 301, name: 'IT/소프트웨어', description: '정보기술' },
  { code: 302, name: '반도체', description: '반도체/디스플레이' },
  { code: 303, name: '바이오', description: '바이오/제약' },
  { code: 304, name: '게임', description: '게임' },
  { code: 401, name: '금융', description: '은행/증권/보험' },
  { code: 501, name: '해운', description: '해운업' },
  { code: 502, name: '항공', description: '항공운수' },
  { code: 503, name: '방산', description: '방위산업' },
  { code: 999, name: '기타', description: '기타 업종' },
];
```

## 주의사항

1. **테마 코드는 숫자**: 테마 코드는 반드시 숫자로 전송해야 합니다 (`101`, `302` 등)
2. **0은 전체**: `0` 테마는 모든 종목을 반환합니다 (필터 없음과 동일)
3. **매칭 정확도**: 키움 API의 `upName` 값이 정확하지 않을 수 있으므로, 부분 매칭을 사용합니다
4. **GET vs POST**:
   - 간단한 필터링: GET 사용
   - 복잡한 RS 필터 + 테마: POST 사용
5. **쿼리 파라미터**: GET 요청 시 숫자도 문자열로 전달됩니다 (`?theme=101`)
6. **타입 안정성**: TypeScript 사용 시 ThemeCode 타입을 활용하여 타입 안정성 확보

## 문의사항

테마 코드 추가 요청이나 매칭 로직 개선이 필요한 경우 백엔드 팀에 문의해주세요.
