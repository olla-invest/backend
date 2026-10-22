import type { AdminRole, AuthProvider, PlanType, UserStatus } from './api';

// 화면의 일시는 모두 KST, yyyy-MM-dd HH:mm:ss (기획서 5.1). sv-SE 로캘이 이 형식을 그대로 만든다.
const dateTimeFormat = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Seoul',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});
const dateFormat = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Seoul',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function toDate(value: string | Date | null | undefined): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatDateTime(value: string | Date | null | undefined): string {
  const date = toDate(value);
  return date ? dateTimeFormat.format(date) : '-';
}

export function formatDate(value: string | Date | null | undefined): string {
  const date = toDate(value);
  return date ? dateFormat.format(date) : '-';
}

/** KST 기준 오늘 (yyyy-MM-dd) */
export function todayKst(): string {
  return dateFormat.format(new Date());
}

export function addDays(date: string, days: number): string {
  const base = new Date(`${date}T00:00:00Z`);
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}

export function formatNumber(value: number): string {
  return value.toLocaleString('ko-KR');
}

export const PLAN_OPTIONS: PlanType[] = ['FREE', 'BASIC', 'PRO', 'PREMIUM'];
export const PLAN_LABELS: Record<PlanType, string> = {
  FREE: 'Free',
  BASIC: 'Basic',
  PRO: 'Pro',
  PREMIUM: 'Premium',
};

export const PROVIDER_OPTIONS: AuthProvider[] = ['LOCAL', 'KAKAO', 'NAVER'];
export const PROVIDER_LABELS: Record<AuthProvider, string> = {
  LOCAL: 'Local',
  KAKAO: 'KAKAO',
  NAVER: 'NAVER',
};

export const STATUS_FILTER_OPTIONS: UserStatus[] = ['ACTIVE', 'INACTIVE', 'DORMANT', 'DELETED'];
/** 상태 변경 팝업에서 고를 수 있는 상태 (기획 피그마 기준 Active / Inactive) */
export const STATUS_CHANGE_OPTIONS: UserStatus[] = ['ACTIVE', 'INACTIVE'];
export const STATUS_LABELS: Record<UserStatus, string> = {
  ACTIVE: 'Active',
  INACTIVE: 'Inactive',
  DORMANT: '휴면',
  DELETED: '삭제',
};

export const ROLE_LABELS: Record<AdminRole, string> = {
  SUPER_ADMIN: '최고 관리자',
  OPERATOR: '운영자',
  VIEWER: '조회 전용',
};

/** VIEWER 는 조회만 가능하다 (마스킹 해제·운영 액션 불가). */
export function canOperate(role: AdminRole | undefined): boolean {
  return role === 'SUPER_ADMIN' || role === 'OPERATOR';
}

export function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value.trim());
}

export function phoneDigits(value: string): string {
  return value.replace(/\D/g, '');
}

/** 비어 있으면 통과, 입력했다면 숫자 10~11자리 (기획 피그마 정보 수정 검증) */
export function isValidPhone(value: string): boolean {
  const digits = phoneDigits(value);
  return digits.length === 0 || digits.length === 10 || digits.length === 11;
}

/** 저장할 때 하이픈을 자동으로 넣는다. */
export function formatPhone(value: string): string {
  const digits = phoneDigits(value);
  if (digits.startsWith('02')) {
    return digits.length === 10
      ? `${digits.slice(0, 2)}-${digits.slice(2, 6)}-${digits.slice(6)}`
      : `${digits.slice(0, 2)}-${digits.slice(2, 5)}-${digits.slice(5)}`;
  }
  if (digits.length === 11) return `${digits.slice(0, 3)}-${digits.slice(3, 7)}-${digits.slice(7)}`;
  if (digits.length === 10) return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
  return digits;
}
