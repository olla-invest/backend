# Real-Time Chart API

실시간 차트 조회 - 필터 조건에 따라 종목 스크리닝 및 랭킹 결과 반환

## Endpoint

```
GET /real-time-chart
```

## Query Parameters

| 파라미터              | 타입    	 | 필수 | 기본값                    | 설명                                    |
| ------------------- | ------------- | ---- | ------------------------- | --------------------------------------- |
| rsPeriods           | RsPeriod[]    | -    | 63영업일/100%             | RS 기간/비율 설정 (JSON string)         |
| minTradingValue     | number        | -    | 1000000000                | 최소 거래대금 (원)                      |
| marketType          | string        | -    | 전체                      | 거래소 필터 (KOSPI / KOSDAQ)            |
| newHighTypes        | string[]      | -    | ['ALL_TIME', 'YEARLY']    | 신고가 기준 (콤마 구분)                 |
| includeNonNewHigh   | boolean       | -    | true                      | 신고가 미해당 종목 포함 여부            |
| theme               | string        | -    | 전체                      | 테마 필터                               |
| queryStartDate      | string        | -    | -                         | 조회 시작일 (ISO 8601)                  |
| queryEndDate        | string        | -    | 오늘                      | 조회 종료일 (ISO 8601)                  |
| page                | number        | -    | 1                         | 페이지 번호                             |
| limit               | number        | -    | 10                        | 페이지당 개수                           |

## RsPeriod

| 필드      | 타입   | 설명                            |
| --------- | ------ | ------------------------------- |
| startDate | string | 시작일 (ISO 8601)               |
| endDate   | string | 종료일 (ISO 8601)               |
| weight    | number | 비율 (%, 합계 100)              |

## NewHighType

| 값       | 설명              |
| -------- | ----------------- |
| ALL_TIME | 전체기간 신고가   |
| YEARLY   | 52주 신고가       |
