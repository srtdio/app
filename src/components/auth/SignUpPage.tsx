import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { Client } from '@srtdio/rpc';
import { workspaceCreate } from '@srtdio/rpc';
import type { Json } from '@srtdio/schemas';
import { AuthShell } from '@/components/auth/AuthShell';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { supabase } from '@/lib/supabase';
import { useNewTrace } from '@/lib/trace-context';

/** Runtime-detected IANA timezone; shown prefilled and editable. */
function detectTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return '';
  }
}

export function SignUpPage() {
  const navigate = useNavigate();
  const newTrace = useNewTrace();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [workspaceName, setWorkspaceName] = useState('');
  const [timezone, setTimezone] = useState(detectTimezone);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSignUp(): Promise<void> {
    setError(null);
    setSubmitting(true);

    const { error: signUpError } = await supabase.auth.signUp({
      email,
      password,
      options: { data: { display_name: name } },
    });
    if (signUpError) {
      setError(signUpError.message);
      setSubmitting(false);
      return;
    }

    // Fresh uuid_v7 trace id from the same utility the TraceProvider uses; the
    // workspaceCreate wrapper forwards it unchanged as p_trace_id. Actor is
    // auth.uid() server-side, never passed from the client.
    const payload: Json = { name: workspaceName, timezone };
    const result = await workspaceCreate(supabase as unknown as Client, {
      p_payload: payload,
      p_trace_id: newTrace(),
    });
    if (!result.ok) {
      setError(result.error.message);
      setSubmitting(false);
      return;
    }

    navigate('/pipeline', { replace: true });
  }

  return (
    <AuthShell
      title="Create your account"
      subtitle="Set up your workspace on Sorted."
      footer={
        <Link
          to="/signin"
          className="inline-flex min-h-[44px] items-center justify-center text-accent hover:underline"
        >
          Sign in
        </Link>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Name" htmlFor="signup-name">
          <Input
            id="signup-name"
            type="text"
            autoComplete="name"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>

        <Field label="Email" htmlFor="signup-email">
          <Input
            id="signup-email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </Field>

        <Field label="Password" htmlFor="signup-password">
          <Input
            id="signup-password"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </Field>

        <Field label="Workspace name" htmlFor="signup-workspace">
          <Input
            id="signup-workspace"
            type="text"
            value={workspaceName}
            onChange={(event) => setWorkspaceName(event.target.value)}
          />
        </Field>

        <Field
          label="Workspace timezone"
          htmlFor="signup-timezone"
          hint="Detected automatically. Edit if it looks wrong."
        >
          <Input
            id="signup-timezone"
            type="text"
            value={timezone}
            onChange={(event) => setTimezone(event.target.value)}
          />
        </Field>

        {error !== null ? <p className="text-sm text-bad">{error}</p> : null}

        <Button
          variant="primary"
          size="lg"
          className="w-full"
          onClick={handleSignUp}
          disabled={submitting}
        >
          {submitting ? 'Creating account' : 'Create account'}
        </Button>
      </div>
    </AuthShell>
  );
}
