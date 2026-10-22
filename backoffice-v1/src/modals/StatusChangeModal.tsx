import { useState } from 'react';
import type { ApiClient, UserStatus } from '../api';
import { StatusChip } from '../components/Badges';
import { Field, Modal } from '../components/Modal';
import { STATUS_CHANGE_OPTIONS, STATUS_LABELS } from '../format';
import { useSubmit } from './useSubmit';

interface StatusChangeModalProps {
  api: ApiClient;
  /** 1명이면 단건 변경, 여러 명이면 목록의 일괄 변경 */
  userIds: string[];
  currentStatus?: UserStatus;
  onClose: () => void;
  onDone: (message: string) => void;
}

export function StatusChangeModal({ api, userIds, currentStatus, onClose, onDone }: StatusChangeModalProps) {
  const bulk = currentStatus === undefined;
  const options = STATUS_CHANGE_OPTIONS.filter((status) => status !== currentStatus);
  const [status, setStatus] = useState<UserStatus>(options[0]);
  const [reason, setReason] = useState('');
  const { submitting, error, run } = useSubmit();
  const valid = reason.trim().length > 0;

  const submit = () =>
    run(async () => {
      if (bulk) {
        const result = await api.patch<{ requested: number; changed: number; skipped: number }>('/admin/users/status', {
          userIds,
          status,
          reason: reason.trim(),
        });
        onDone(
          `${result.changed}명을 ${STATUS_LABELS[status]}로 변경했습니다.` +
            (result.skipped > 0 ? ` (이미 같은 상태 ${result.skipped}명 제외)` : ''),
        );
        return;
      }
      await api.patch(`/admin/users/${userIds[0]}/status`, { status, reason: reason.trim() });
      onDone(`상태를 ${STATUS_LABELS[status]}로 변경했습니다.`);
    });

  return (
    <Modal
      title={bulk ? '일괄 상태 변경' : '상태 변경'}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="button" onClick={onClose}>
            취소
          </button>
          <button type="button" className="button button-danger" disabled={!valid || submitting} onClick={submit}>
            변경
          </button>
        </>
      }
    >
      <div className="modal-row">
        <span className="modal-row-label">{bulk ? '대상 회원' : '현재 상태'}</span>
        {currentStatus ? <StatusChip status={currentStatus} /> : <strong>{userIds.length}명</strong>}
      </div>
      <Field label="변경할 상태" required>
        <select value={status} onChange={(event) => setStatus(event.target.value as UserStatus)}>
          {options.map((option) => (
            <option key={option} value={option}>
              {STATUS_LABELS[option]}
            </option>
          ))}
        </select>
      </Field>
      <Field label="상태 변경 사유" required error={error}>
        <textarea
          value={reason}
          maxLength={500}
          placeholder="상태 변경 사유를 입력해 주세요"
          onChange={(event) => setReason(event.target.value)}
        />
      </Field>
      <p className="modal-subtext">
        {status === 'INACTIVE'
          ? 'Inactive로 변경하면 즉시 로그인이 차단되고 모든 세션이 만료됩니다.'
          : 'Active로 변경하면 즉시 계정이 활성화됩니다.'}
      </p>
    </Modal>
  );
}
