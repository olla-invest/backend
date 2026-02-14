/**
 * 실시간 데이터 소스 인터페이스
 * KiwoomWebSocketService와 RedisRealtimeSubscriberService가 구현
 */
export interface IRealtimeSource {
  /**
   * 종목 실시간 구독
   * @param stockCode 종목코드 (예: "005930")
   * @param types 구독 타입 배열 (예: ["0B", "0D"])
   */
  subscribe(stockCode: string, types: string[]): Promise<void>;

  /**
   * 종목 실시간 구독 해제
   * @param stockCode 종목코드
   * @param types 구독 해제할 타입 배열 (없으면 전체 해제)
   */
  unsubscribe(stockCode: string, types?: string[]): Promise<void>;

  /**
   * 연결 상태 확인
   */
  isConnected(): boolean;

  /**
   * 연결 보장 (연결되어 있지 않으면 연결 시도)
   */
  ensureConnection(): Promise<void>;
}

/**
 * 실시간 소스 주입 토큰
 */
export const REALTIME_SOURCE_TOKEN = 'REALTIME_SOURCE_TOKEN';
