import type { PlanType, UserStatus } from '../api';
import { PLAN_LABELS, STATUS_LABELS } from '../format';

export function StatusBadge({ status }: { status: UserStatus }) {
  return <span className={`status-badge status-${status.toLowerCase()}`}>{STATUS_LABELS[status]}</span>;
}

/** 팝업의 '현재 플랜·현재 상태' 표시용 칩 */
export function ValueChip({ children, tone = 'gray' }: { children: string; tone?: 'gray' | 'blue' }) {
  return <span className={`value-chip value-chip-${tone}`}>{children}</span>;
}

export function PlanChip({ plan }: { plan: PlanType }) {
  return <ValueChip>{PLAN_LABELS[plan].toUpperCase()}</ValueChip>;
}

export function StatusChip({ status }: { status: UserStatus }) {
  return <ValueChip tone="blue">{STATUS_LABELS[status].toUpperCase()}</ValueChip>;
}
