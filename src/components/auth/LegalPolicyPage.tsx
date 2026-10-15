import { Link, Navigate, useParams } from 'react-router-dom';
import { AuthShell } from '@/components/auth/AuthShell';

const policies = {
  'privacy-policy': {
    title: 'Privacy Policy',
  },
  'terms-and-conditions': {
    title: 'Terms & Conditions',
  },
} as const;

function PrivacyPolicyContent() {
  return (
    <div className="space-y-6 text-sm leading-6 text-fg-2">
      <p>Last Updated: 08 Oct 2026</p>
      <p>
        This Privacy Policy explains how we collect, use, share and protect your personal data when
        you use srtd.io and the Sorted app. Sorted is a tool for social media agencies and their
        clients to write briefs, draft posts, review them and approve them.
      </p>
      <p>
        By using the Service you agree to this Policy. If you don&apos;t agree, please don&apos;t
        use the Service.
      </p>

      <section>
        <h2 className="mb-2 text-base font-semibold text-fg">1. What we collect</h2>
        <div className="space-y-4">
          <p>
            <strong className="font-medium text-fg">a) Account details you give us:</strong> Name
            (shown as your display name), email address and password. Your password is stored as a
            hash, never in plain text.
          </p>
          <div>
            <p>
              <strong className="font-medium text-fg">b) Content you create or upload:</strong>
            </p>
            <ul className="list-disc space-y-1 pl-6">
              <li>Briefs, post drafts, captions, versions, comments, annotations and reactions.</li>
              <li>
                Files you upload (images, documents and similar), including files shared in chat.
              </li>
              <li>
                Chat messages (direct and group), mentions, read position, reminders and starred
                messages.
              </li>
              <li>
                Workspace settings, members, roles and invitations. If you invite someone, we get
                their email address from you.
              </li>
            </ul>
          </div>
          <div>
            <p>
              <strong className="font-medium text-fg">c) Billing details:</strong>
            </p>
            <ul className="list-disc space-y-1 pl-6">
              <li>Which plan a workspace is on, billing status and payment history.</li>
              <li>Payments are handled by our payment provider, CashFree/Razorpay.</li>
            </ul>
          </div>
        </div>
      </section>

      <section>
        <h2 className="mb-2 text-base font-semibold text-fg">3. What we don&apos;t collect</h2>
        <ul className="list-disc pl-6">
          <li>
            We don&apos;t ask for your social media account passwords. We do not see or store your
            full card number, UPI PIN or net banking credentials. We keep identifiers and status
            information returned by the provider.
          </li>
        </ul>
      </section>

      <section>
        <h2 className="mb-2 text-base font-semibold text-fg">4. Cookies and local storage</h2>
        <p>
          We use only what the app needs to work: keeping you signed in (session tokens in your
          browser storage or cookies), remembering preferences such as the active workspace, and
          protecting your account. We don&apos;t use advertising or cross-site tracking cookies.
        </p>
      </section>

      <section>
        <h2 className="mb-2 text-base font-semibold text-fg">5. How we use your data</h2>
        <ul className="list-disc space-y-1 pl-6">
          <li>To create your account, sign you in and keep it secure.</li>
          <li>
            To run the Service: store and show briefs, posts, comments, files and chat to the right
            people.
          </li>
          <li>
            To send notifications: in-app, push, and email (for example mentions, review requests
            and billing notices). Email notifications are bundled and sent during daytime hours in
            your workspace timezone.
          </li>
          <li>To prevent abuse and fraud, fix bugs, and keep the Service reliable.</li>
          <li>To answer your support requests.</li>
        </ul>
        <p className="mt-3">
          We rely on your consent and on what is necessary to provide the Service you signed up for.
          Where required by law, we process data for legitimate uses permitted under the Digital
          Personal Data Protection Act, 2023.
        </p>
      </section>

      <section>
        <h2 className="mb-2 text-base font-semibold text-fg">6. Who we share data with</h2>
        <p className="mb-3">
          We share data only with service providers who help us run Sorted, and only as needed:
        </p>
        <ul className="list-disc space-y-2 pl-6">
          <li>
            <strong className="font-medium text-fg">Supabase:</strong> Database, authentication,
            realtime updates.
          </li>
          <li>
            <strong className="font-medium text-fg">Cloudflare:</strong> Hosting, Workers, file
            storage (R2), uploaded files, avatars.
          </li>
          <li>
            <strong className="font-medium text-fg">Agora:</strong> Live delivery of chat messages
            and push for mentions. Chat user ID, message content in transit.
          </li>
          <li>
            <strong className="font-medium text-fg">Resend:</strong> Sending emails. Email address,
            name, email content.
          </li>
          <li>
            <strong className="font-medium text-fg">CashFree/Razorpay:</strong> Payments. Name,
            email, payment details you enter with them.
          </li>
        </ul>
      </section>
      <section>
        <h2 className="mb-2 text-base font-semibold text-fg">7. How to contact Us</h2>
        <p className="mb-3">
          If you have questions or concerns about this Privacy Policy, please contact us at{' '}
          <a
            href="mailto:support@srtd.io"
            className="text-accent underline underline-offset-2 transition-colors hover:text-accent/80"
          >
            support@srtd.io
          </a>
        </p>
      </section>
    </div>
  );
}

function TermsAndConditionsContent() {
  return (
    <div className="space-y-6 text-sm leading-6 text-fg-2">
      <p>Last Updated: 08 Oct 2026</p>
      <p>
        These Terms and Conditions govern your use of srtd.io and the Sorted platform. By creating
        an account or using the Service, you agree to comply with these terms and conditions.
      </p>

      <section>
        <h2 className="mb-2 text-base font-semibold text-fg">1. Acceptance of terms</h2>
        <p>
          By accessing or using the Service, you confirm that you are at least 18 years old and have
          the authority to enter into this agreement on behalf of your organization, if applicable.
        </p>
      </section>

      <section>
        <h2 className="mb-2 text-base font-semibold text-fg">2. Account responsibilities</h2>
        <ul className="list-disc space-y-1 pl-6">
          <li>You are responsible for the accuracy of the information you provide.</li>
          <li>
            You must keep your login credentials secure and notify us immediately of misuse. One
            person per login. Do not share credentials.
          </li>
          <li>You are responsible for all activity that occurs under your account.</li>
        </ul>
      </section>

      <section>
        <h2 className="mb-2 text-base font-semibold text-fg">3. Use of the platform</h2>
        <p>
          You may use the Service only for lawful business purposes and in accordance with the
          project&apos;s rules, workspace policies, and any applicable regulations.
        </p>
      </section>

      <section>
        <h2 className="mb-2 text-base font-semibold text-fg">4. Content and workflow</h2>
        <p>
          Users may create, upload, edit, review, and approve content within their assigned
          workspace. You remain responsible for the content you submit and any approvals or
          rejections made through the Service.
        </p>
      </section>

      <section>
        <h2 className="mb-2 text-base font-semibold text-fg">5. Subscription and payments</h2>
        <p>
          Certain features may require a paid plan or subscription. Fees, billing periods, and
          payment terms will be disclosed before you confirm your purchase.
        </p>
      </section>

      <section>
        <h2 className="mb-2 text-base font-semibold text-fg">6. Intellectual property</h2>
        <p>
          You retain ownership of the content you upload to the platform, subject to the rights and
          permissions granted to us for hosting, processing, and delivering the Service.
        </p>
      </section>

      <section>
        <h2 className="mb-2 text-base font-semibold text-fg">7. Limitation of liability</h2>
        <p>
          We do not guarantee uninterrupted service and are not liable for indirect, incidental, or
          consequential losses arising from the use of the Service, except where required by law.
        </p>
      </section>

      <section>
        <h2 className="mb-2 text-base font-semibold text-fg">8. Termination</h2>
        <p>
          We may suspend or terminate access to the Service if you violate these terms, misuse the
          platform, or create unacceptable risk for other users or the service itself.
        </p>
      </section>

      <section>
        <h2 className="mb-2 text-base font-semibold text-fg">9. Contact</h2>
        <p>
          For questions regarding these terms, contact us at{' '}
          <a
            href="mailto:support@srtd.io"
            className="text-accent underline underline-offset-2 transition-colors hover:text-accent/80"
          >
            support@srtd.io
          </a>
        </p>
      </section>
    </div>
  );
}

export function LegalPolicyPage() {
  const { policy } = useParams();

  if (policy !== 'privacy-policy' && policy !== 'terms-and-conditions') {
    return <Navigate to="/signup" replace />;
  }

  const { title } = policies[policy];

  return (
    <AuthShell
      title={title}
      subtitle="Please read the following information carefully."
      wide={policy === 'privacy-policy'}
      footer={
        <Link
          to="/signup"
          className="inline-flex min-h-[44px] items-center justify-center text-accent hover:underline"
        >
          Back to sign up
        </Link>
      }
    >
      {policy === 'privacy-policy' ? <PrivacyPolicyContent /> : <TermsAndConditionsContent />}
    </AuthShell>
  );
}
