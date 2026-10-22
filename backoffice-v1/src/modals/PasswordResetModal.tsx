import { useState } from 'react';
import type { ApiClient } from '../api';
import { Field, Modal } from '../components/Modal';
import { useSubmit } from './useSubmit';

interface PasswordResetModalProps {
  api: ApiClient;
  userId: string;
  maskedEmail: string | null;
  onClose: () => void;
  onDone: (message: string) => void;
}

/**
 * 비밀번호 초기화.
 * 기획 팝업 문구는 '재설정 링크 발송'이지만 현재 서버는 임시 비밀번호를 발급해 메일로 보낸다(기존 비밀번호는 바로 바뀐다).
 * 실제 동작과 다르게 안내하지 않도록 서버 동작 기준으로 문구를 쓴다.
 */
export function PasswordResetModal({ api, userId, maskedEmail, onClose, onDone }: PasswordResetModalProps) {
  const [reason, setReason] = useState('');
  const { submitting, error, run } = useSubmit();
  const valid = reason.trim().length > 0;

  const submit = () =>
    run(async () => {
      const result = await api.post<{ email: string | null }>(`/admin/users/${userId}/password-reset`, {
        reason: reason.trim(),
      });
      onDone(`${result.email ?? '회원 이메일'}로 임시 비밀번호를 발송했습니다.`);
    });

  return (
    <Modal
      title="비밀번호 초기화"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="button" onClick={onClose}>
            취소
          </button>
          <button type="button" className="button button-primary" disabled={!valid || submitting} onClick={submit}>
            발송
          </button>
        </>
      }
    >
      <p className="modal-text">
        회원 이메일 <strong>{maskedEmail ?? '-'}</strong> 으로 임시 비밀번호를 발송합니다.
      </p>
      <p className="modal-subtext">
        발송 즉시 기존 비밀번호는 사용할 수 없고, 회원은 임시 비밀번호로 로그인한 뒤 새 비밀번호를 설정합니다. 관리자는
        비밀번호를 확인할 수 없습니다.
      </p>
      <Field label="사유" required error={error}>
        <textarea
          value={reason}
          maxLength={500}
          placeholder="비밀번호를 초기화하는 사유를 입력해 주세요"
          onChange={(event) => setReason(event.target.value)}
        />
      </Field>
    </Modal>
  );
}
