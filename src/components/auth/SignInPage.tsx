import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { AuthShell } from '@/components/auth/AuthShell';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { supabase } from '@/lib/supabase';

export function SignInPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSignIn(): Promise<void> {
    setError(null);
    setSubmitting(true);
    const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
    if (signInError) {
      setError(signInError.message);
      setSubmitting(false);
      return;
    }
    const rawFrom = (location.state as { from?: unknown } | null)?.from;
    const dest =
      typeof rawFrom === 'string' && rawFrom.startsWith('/') && !rawFrom.startsWith('//')
        ? rawFrom
        : '/pipeline';
    navigate(dest, { replace: true });
  }

  return (
    <AuthShell
      title="Sign in"
      subtitle="Welcome back to Sorted."
      footer={
        <Link
          to="/signup"
          className="inline-flex min-h-[44px] items-center justify-center text-accent hover:underline"
        >
          Create an account
        </Link>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Email" htmlFor="signin-email">
          <Input
            id="signin-email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </Field>

        <div>
          <div className="flex items-center justify-between">
            <label htmlFor="signin-password" className="block text-sm font-medium mb-1.5">
              Password
            </label>
            <a
              href="#"
              className="inline-flex min-h-[44px] items-center text-xs text-fg-2 hover:text-fg"
            >
              Forgot?
            </a>
          </div>
          <Input
            id="signin-password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </div>

        {error !== null ? <p className="text-sm text-bad">{error}</p> : null}

        <Button
          variant="primary"
          size="lg"
          className="w-full"
          onClick={handleSignIn}
          disabled={submitting}
        >
          {submitting ? 'Signing in' : 'Sign in'}
        </Button>
      </div>
    </AuthShell>
  );
}
