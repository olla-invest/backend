import { useState } from 'react';
import { errorMessage } from '../api';

/** 팝업 제출 상태: 중복 제출을 막고 서버 오류 문구를 그대로 보여준다. */
export function useSubmit() {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(action: () => Promise<void>) {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await action();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setSubmitting(false);
    }
  }

  return { submitting, error, setError, run };
}
