import { useState, type FormEvent } from 'react';
import { errorMessage } from '../api';
import { useAuth } from '../auth';
import { Logo } from '../components/Layout';

export function LoginPage() {
  const { login } = useAuth();
  const [loginId, setLoginId] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!loginId.trim() || !password || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await login(loginId.trim(), password);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="login-page">
      <form className="login-card" onSubmit={submit}>
        <div className="login-logo">
          <Logo />
          <span>백오피스</span>
        </div>
        <label className="field">
          <span className="field-label">로그인 ID</span>
          <input value={loginId} autoComplete="username" autoFocus onChange={(event) => setLoginId(event.target.value)} />
        </label>
        <label className="field">
          <span className="field-label">비밀번호</span>
          <input
            type="password"
            value={password}
            autoComplete="current-password"
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>
        {error && <p className="form-error">{error}</p>}
        <button type="submit" className="button button-primary button-block" disabled={!loginId.trim() || !password || submitting}>
          {submitting ? '로그인 중…' : '로그인'}
        </button>
      </form>
    </div>
  );
}
