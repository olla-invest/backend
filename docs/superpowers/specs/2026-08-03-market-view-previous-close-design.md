# Market View Previous Close Design

## Goal

`GET /market-view`의 `markets[].index.previousClose`에 당일 변동값으로 역산한 값이 아니라, 해당 시장의 직전 거래일 스냅샷에 저장된 실제 지수 종가를 반환한다.

## Data Flow

1. 최신 마켓뷰 거래일과 KOSPI/KOSDAQ 스냅샷을 조회한다.
2. 각 시장에 대해 최신 거래일보다 이른 스냅샷을 거래일 내림차순으로 한 건 조회한다.
3. 직전 거래일 스냅샷의 `indexClose`를 `markets[].index.previousClose`에 숫자로 반환한다.
4. 직전 거래일 스냅샷이 없으면 `previousClose`는 `null`을 반환한다.

여기서 직전 거래일은 달력상 전날이 아니다. 월요일에는 금요일, 공휴일 또는 연휴 다음 거래일에는 휴장 전 마지막 거래일을 의미한다.

## API Compatibility

필드명과 응답 구조는 유지한다. 변경 대상은 `GET /market-view`의 `markets[].index.previousClose` 값 산출 방식뿐이다. `GET /market-view/markets/:marketType/index-candles`의 `previousClose`는 이미 같은 직전 거래일 조회 규칙을 사용하므로 유지한다.

## Implementation

최신 거래일보다 작은 거래일 가운데 가장 최근 스냅샷을 시장별로 조회하고, 시장 타입을 키로 하는 맵을 구성해 응답 변환 함수에 전달한다. 응답 변환 함수는 전달받은 직전 스냅샷의 종가만 사용하며 `indexChange`로 역산하지 않는다.

## Testing

- 당일 종가와 변동값의 차이가 실제 직전 거래일 종가와 다르도록 fixture를 구성해, 역산값이 아닌 저장된 `indexClose`가 반환되는지 검증한다.
- 주말을 사이에 둔 월요일/금요일 날짜를 사용해 `tradeDate < current` 및 내림차순 조회가 직전 거래일을 선택하는지 검증한다.
- 직전 스냅샷이 없을 때 `previousClose: null`인지 검증한다.
- 기존 index-candles 테스트 mock과 기대값에 `previousClose` 조회 동작을 반영한다.
