# Issue Theme Favorite and Stock Short-Term RS Design

## Goal

로그인 사용자의 이슈테마 목록에서 실제 관심 여부를 `isFavorite`로 반환하는 HTTP 경로를 검증하고, 테마 상세의 각 종목에 최근 3거래일 RS 평균을 `shortTermRs`로 반환한다.

## Favorite Data Flow

`GET /issue-theme`는 선택적 JWT 인증을 유지한다. 유효한 Bearer 토큰이 있으면 JWT의 `sub`에 해당하는 사용자를 확인해 `userId`를 컨트롤러에서 서비스로 전달한다. 서비스는 삭제되지 않은 `user_watchlist_themes` 행을 한 번에 조회하고 일치하는 `themeCode`의 `isFavorite`를 `true`로 반환한다. 토큰이 없는 공개 요청은 기존처럼 `false`를 반환한다.

검증은 유효한 JWT를 포함한 실제 HTTP 목록 요청으로 수행한다. 관심 테마와 일반 테마가 함께 있을 때 각각 `true`, `false`인지 확인한다.

## Stock Short-Term RS

테마 상세에 포함될 종목 전체를 대상으로 `stock_daily_metrics`를 배치 조회한다. 최신 거래일 이하의 서로 다른 최근 3개 거래일을 기준으로 종목별 `relativeStrengthScore`를 수집하고 산술 평균을 소수점 둘째 자리로 반올림한다.

종목이 기준 3거래일 모두에 RS 데이터를 가진 경우에만 `stocks[].shortTermRs`를 숫자로 반환한다. 하나라도 누락되면 해당 종목의 값은 `null`이다. 달력 날짜가 아니라 DB에 존재하는 거래일을 사용하므로 주말과 휴장일은 기간에 포함되지 않는다.

`stockSort=shortTermRs`는 계산된 값을 내림차순으로 정렬하고 `null`은 마지막에 둔다. 값이 같으면 종목코드 오름차순을 사용한다.

## Query and Compatibility

종목별 개별 조회를 하지 않는다. 최근 3거래일 확인 쿼리와 해당 날짜·대상 종목의 지표 배치 쿼리를 사용한다. 기존 응답 필드와 기본 정렬은 변경하지 않는다.

## Tests

- 유효한 JWT가 포함된 목록 HTTP 요청에서 관심 테마는 `isFavorite: true`, 비관심 테마는 `false`인지 검증한다.
- 최근 3거래일 RS가 `70`, `80`, `90`이면 `shortTermRs: 80`인지 검증한다.
- 기준 거래일 중 하나가 누락된 종목은 `shortTermRs: null`인지 검증한다.
- `stockSort=shortTermRs`가 숫자 내림차순, `null` 마지막, 동점 종목코드 오름차순인지 검증한다.
- 배치 조회 조건이 대상 종목과 최근 3거래일로 제한되는지 검증한다.
