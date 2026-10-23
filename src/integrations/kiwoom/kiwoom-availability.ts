import { ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * KIWOOM_ENABLED=false 인 환경(개발 서버)은 키움을 전혀 호출하지 않는다.
 * 토큰 발급·REST 조회·실시간 연결이 모두 꺼지고, 데이터는 운영 DB 동기화로만 받는다.
 * 같은 키움 계정의 호출 한도(초당 4건)를 운영과 나눠 쓰지 않기 위해서다.
 */
export function isKiwoomEnabled(config: ConfigService): boolean {
  return String(config.get('KIWOOM_ENABLED', 'true')) !== 'false';
}

/** 실시간 체결 연결·구독. REALTIME_ENABLED=false 이거나 키움이 꺼져 있으면 꺼진다. */
export function isRealtimeEnabled(config: ConfigService): boolean {
  return isKiwoomEnabled(config) && String(config.get('REALTIME_ENABLED', 'true')) !== 'false';
}

export class KiwoomDisabledError extends ServiceUnavailableException {
  constructor() {
    super('키움 연동이 꺼진 환경입니다 (KIWOOM_ENABLED=false).');
  }
}
