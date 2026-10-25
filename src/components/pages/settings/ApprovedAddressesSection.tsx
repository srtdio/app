// Owner-only: the extra company domains an approver may use besides the
// client's own (workspace_client_domains rows with removed_at null). Add calls
// workspace_client_domain_add, Remove confirms then calls ..._remove; both
// procs re-check that the caller owns the workspace.

import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { useToast } from '@/components/ui/toast';
import { supabase } from '@/lib/supabase';
import { useNewTrace } from '@/lib/trace-context';
import {
  addClientDomain,
  approverAddressIntro,
  clientDomainErrorMessage,
  isValidDomain,
  listClientDomains,
  normalizeDomain,
  removeClientDomain,
} from './workspace-settings-data';

export function ApprovedAddressesSection({
  workspaceId,
  clientDomain,
}: {
  workspaceId: string;
  clientDomain: string | null;
}) {
  const newTrace = useNewTrace();
  const toast = useToast();
  const [domains, setDomains] = useState<string[]>([]);
  const [loadError, setLoadError] = useState(false);
  const [draft, setDraft] = useState('');
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmFor, setConfirmFor] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);

  const load = useCallback(async () => {
    const res = await listClientDomains(supabase, workspaceId);
    if (!res.ok) {
      setLoadError(true);
      return;
    }
    setLoadError(false);
    setDomains(res.data);
  }, [workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function add(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const domain = normalizeDomain(draft);
    if (!isValidDomain(domain)) {
      setError(clientDomainErrorMessage('invalid_payload'));
      return;
    }
    setAdding(true);
    setError(null);
    const res = await addClientDomain(supabase, { workspaceId, domain, traceId: newTrace() });
    setAdding(false);
    if (!res.ok) {
      setError(clientDomainErrorMessage(res.error.message));
      return;
    }
    setDraft('');
    toast.show({ title: `${domain} approved`, tone: 'success' });
    void load();
  }

  async function remove(domain: string): Promise<void> {
    setRemoving(true);
    const res = await removeClientDomain(supabase, { workspaceId, domain, traceId: newTrace() });
    setRemoving(false);
    setConfirmFor(null);
    if (!res.ok) {
      toast.show({ title: clientDomainErrorMessage(res.error.message) });
      return;
    }
    toast.show({ title: `${domain} removed` });
    void load();
  }

  return (
    <section
      aria-labelledby="approved-addresses-title"
      className="flex flex-col gap-3 rounded-xl border border-border bg-panel p-4"
    >
      <div>
        <h3
          id="approved-addresses-title"
          className="text-sm font-semibold uppercase tracking-[0.06em] text-fg-2"
        >
          Approved approver addresses
        </h3>
        <p className="mt-1 text-base text-fg-2">{approverAddressIntro(clientDomain)}</p>
      </div>

      {loadError ? (
        <p className="text-base text-bad">Couldn&apos;t load addresses. Try again.</p>
      ) : domains.length > 0 ? (
        <ul aria-label="Approved addresses" className="flex flex-col divide-y divide-border">
          {domains.map((domain) => (
            <li key={domain} className="flex items-center gap-3 py-1">
              <span className="min-w-0 flex-1 break-all text-base text-fg">{domain}</span>
              <Button
                type="button"
                variant="ghost"
                aria-label={`Remove ${domain}`}
                onClick={() => setConfirmFor(domain)}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      ) : null}

      <form onSubmit={(e) => void add(e)} className="flex flex-col gap-2">
        <Field label="Add an address" htmlFor="approved-address">
          <Input
            id="approved-address"
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              setError(null);
            }}
            placeholder="groupcompany.com"
            autoCapitalize="none"
            autoComplete="off"
            inputMode="url"
            disabled={adding}
          />
        </Field>
        {error !== null ? (
          <p role="alert" className="text-sm text-bad">
            {error}
          </p>
        ) : null}
        <div>
          <Button type="submit" disabled={adding || draft.trim() === ''}>
            {adding ? 'Adding' : 'Add address'}
          </Button>
        </div>
      </form>

      {confirmFor !== null ? (
        <ConfirmDialog
          title={`Remove ${confirmFor}?`}
          message="New approvers on this address can no longer be invited. People already here stay."
          confirmLabel="Remove"
          busyLabel="Removing"
          destructive
          busy={removing}
          onConfirm={() => void remove(confirmFor)}
          onCancel={() => setConfirmFor(null)}
        />
      ) : null}
    </section>
  );
}
