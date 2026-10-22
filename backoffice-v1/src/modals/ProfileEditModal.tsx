import { useState } from 'react';
import { ApiError, type ApiClient, type UnmaskedProfile } from '../api';
import { Field, Modal } from '../components/Modal';
import { formatPhone, isValidEmail, isValidPhone } from '../format';
import { useSubmit } from './useSubmit';

interface ProfileEditModalProps {
  api: ApiClient;
  userId: string;
  username: string;
  /** 마스킹 해제로 받은 원문. 마스킹 값으로 폼을 채우면 '*' 가 저장될 수 있어 원문만 쓴다. */
  original: UnmaskedProfile;
  onClose: () => void;
  onDone: (message: string) => void;
}

export function ProfileEditModal({ api, userId, username, original, onClose, onDone }: ProfileEditModalProps) {
  const [name, setName] = useState(original.name ?? '');
  const [email, setEmail] = useState(original.email ?? '');
  const [phone, setPhone] = useState(original.phone ?? '');
  const [emailConflict, setEmailConflict] = useState<string | null>(null);
  const { submitting, error, run } = useSubmit();

  // 원문은 유효하므로, 입력을 고쳐 형식이 깨졌을 때만 오류가 보인다.
  const nameError = !name.trim() ? '이름을 입력해 주세요.' : null;
  const emailError = emailConflict ?? (!isValidEmail(email) ? '올바른 이메일 형식을 입력해주세요.' : null);
  const phoneError = !isValidPhone(phone) ? '올바른 전화번호를 입력해주세요.' : null;

  const normalizedPhone = phone.trim() ? formatPhone(phone) : '';
  const changed =
    name.trim() !== (original.name ?? '') ||
    email.trim() !== (original.email ?? '') ||
    normalizedPhone !== (original.phone ? formatPhone(original.phone) : '');
  const valid = !nameError && !emailError && !phoneError;

  const submit = () =>
    run(async () => {
      try {
        await api.patch(`/admin/users/${userId}`, {
          name: name.trim(),
          email: email.trim(),
          ...(normalizedPhone ? { phone: normalizedPhone } : {}),
        });
        onDone('회원정보를 수정했습니다.');
      } catch (caught) {
        if (caught instanceof ApiError && caught.status === 409) {
          setEmailConflict(caught.message);
          return;
        }
        throw caught;
      }
    });

  return (
    <Modal
      title="정보 수정"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="button" onClick={onClose}>
            취소
          </button>
          <button type="button" className="button button-primary" disabled={!changed || !valid || submitting} onClick={submit}>
            수정
          </button>
        </>
      }
    >
      <Field label="ID">
        <input value={username} readOnly disabled />
      </Field>
      <Field label="이름" required error={nameError}>
        <input value={name} maxLength={100} onChange={(event) => setName(event.target.value)} />
      </Field>
      <Field label="이메일" required error={emailError}>
        <input
          type="email"
          value={email}
          maxLength={100}
          onChange={(event) => {
            setEmail(event.target.value);
            setEmailConflict(null);
          }}
        />
      </Field>
      <Field label="전화번호" error={phoneError} hint="숫자만 입력해도 저장할 때 하이픈이 들어갑니다.">
        <input
          inputMode="tel"
          value={phone}
          maxLength={20}
          placeholder="010-1234-5678"
          onChange={(event) => setPhone(event.target.value)}
          onBlur={() => phone.trim() && isValidPhone(phone) && setPhone(formatPhone(phone))}
        />
      </Field>
      {error && <p className="form-error">{error}</p>}
    </Modal>
  );
}
