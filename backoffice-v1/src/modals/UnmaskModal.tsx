import { useState } from 'react';
import type { ApiClient, UnmaskedProfile } from '../api';
import { Field, Modal } from '../components/Modal';
import { useSubmit } from './useSubmit';

interface UnmaskModalProps {
  api: ApiClient;
  userId: string;
  /** edit: 정보 수정 전에 원문이 필요해 해제하는 경우 */
  purpose: 'view' | 'edit';
  onClose: () => void;
  onUnmasked: (profile: UnmaskedProfile) => void;
}

export function UnmaskModal({ api, userId, purpose, onClose, onUnmasked }: UnmaskModalProps) {
  const [reason, setReason] = useState('');
  const { submitting, error, run } = useSubmit();
  const valid = reason.trim().length > 0;

  const submit = () =>
    run(async () => {
      const profile = await api.post<UnmaskedProfile>(`/admin/users/${userId}/unmask`, { reason: reason.trim() });
      onUnmasked(profile);
    });

  return (
    <Modal
      title="마스킹 해제"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="button" onClick={onClose}>
            취소
          </button>
          <button type="button" className="button button-primary" disabled={!valid || submitting} onClick={submit}>
            해제
          </button>
        </>
      }
    >
      <p className="modal-text">
        {purpose === 'edit'
          ? '정보 수정은 개인정보 원문으로 진행해야 해서 마스킹 해제가 먼저 필요합니다.'
          : '이메일·이름·전화번호의 마스킹을 해제합니다.'}
      </p>
      <p className="modal-subtext">해제 사실과 사유는 운영 감사 로그에 기록됩니다.</p>
      <Field label="마스킹 해제 사유" required error={error}>
        <textarea
          value={reason}
          maxLength={500}
          placeholder="마스킹 해제 사유를 입력해 주세요"
          onChange={(event) => setReason(event.target.value)}
          autoFocus
        />
      </Field>
    </Modal>
  );
}
