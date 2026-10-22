import { useState } from 'react';
import type { ApiClient, MemberDetail, PlanType } from '../api';
import { PlanChip } from '../components/Badges';
import { Field, Modal } from '../components/Modal';
import { addDays, formatDate, PLAN_LABELS, PLAN_OPTIONS, todayKst } from '../format';
import { useSubmit } from './useSubmit';

interface PlanChangeModalProps {
  api: ApiClient;
  detail: MemberDetail;
  onClose: () => void;
  onDone: (message: string) => void;
}

export function PlanChangeModal({ api, detail, onClose, onDone }: PlanChangeModalProps) {
  // 시작일은 회원의 다음 결제일로 자동 입력되고 수정할 수 없다. 결제일이 없으면 오늘부터 바로 적용된다.
  const startDate = detail.nextBillingDate ? formatDate(detail.nextBillingDate) : todayKst();
  const [planType, setPlanType] = useState<PlanType | ''>('');
  const [expiresAt, setExpiresAt] = useState('');
  const [reason, setReason] = useState('');
  const { submitting, error, run } = useSubmit();

  const sameAsCurrent = planType === detail.planType;
  const expiresError = expiresAt && expiresAt <= startDate ? '만료일은 시작일 이후여야 합니다.' : null;
  const valid = planType !== '' && !sameAsCurrent && expiresAt !== '' && !expiresError && reason.trim().length > 0;

  const submit = () =>
    run(async () => {
      const result = await api.patch<{ appliedImmediately: boolean; effectiveAt: string }>(
        `/admin/users/${detail.userId}/plan`,
        { planType, expiresAt, reason: reason.trim() },
      );
      onDone(
        result.appliedImmediately
          ? `플랜을 ${PLAN_LABELS[planType as PlanType]}로 변경했습니다.`
          : `${formatDate(result.effectiveAt)}부터 ${PLAN_LABELS[planType as PlanType]} 플랜이 적용됩니다.`,
      );
    });

  return (
    <Modal
      title="플랜 변경"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="button" onClick={onClose}>
            취소
          </button>
          <button type="button" className="button button-primary" disabled={!valid || submitting} onClick={submit}>
            변경
          </button>
        </>
      }
    >
      <div className="modal-row">
        <span className="modal-row-label">현재 플랜</span>
        <PlanChip plan={detail.planType} />
      </div>
      <Field label="변경할 플랜" required error={sameAsCurrent ? '현재 플랜과 동일합니다.' : null}>
        <select value={planType} onChange={(event) => setPlanType(event.target.value as PlanType | '')}>
          <option value="">플랜을 선택해 주세요</option>
          {PLAN_OPTIONS.map((plan) => (
            <option key={plan} value={plan}>
              {PLAN_LABELS[plan].toUpperCase()}
            </option>
          ))}
        </select>
      </Field>
      <div className="field-grid">
        <Field label="시작일" required hint={detail.nextBillingDate ? '다음 결제일' : '결제 예정일이 없어 즉시 적용'}>
          <input type="date" value={startDate} readOnly disabled />
        </Field>
        <Field label="만료일" required error={expiresError}>
          <input
            type="date"
            value={expiresAt}
            min={addDays(startDate, 1)}
            onChange={(event) => setExpiresAt(event.target.value)}
          />
        </Field>
      </div>
      <Field label="사유" required error={error}>
        <textarea
          value={reason}
          maxLength={500}
          placeholder="플랜을 변경하는 사유를 입력해 주세요"
          onChange={(event) => setReason(event.target.value)}
        />
      </Field>
      <p className="modal-subtext">변경된 플랜은 다음 결제일부터 적용됩니다. 그 전까지는 현재 플랜이 유지됩니다.</p>
    </Modal>
  );
}
