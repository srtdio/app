import '@fontsource/inter/latin-400.css';
import '@fontsource/inter/latin-500.css';
import '@fontsource/inter/latin-600.css';
import '@fontsource/inter/latin-700.css';
import { BackHome, NOTE, SiteShell, Tick } from './Chrome';
import { DEMO_HREF, PLANS, SIGNUP_HREF } from './config';
import './home.css';

// /pricing: one price per client workspace. Light only, like /. Cards render
// from PLANS (config.ts); every link is a plain anchor (no router here).

export default function PricingPage() {
  return (
    <SiteShell surface="pricing">
      <section className="page">
        <div className="wrap">
          <BackHome />
          <div className="page-head">
            <h1 className="d">One price per client. Clients are free.</h1>
            <p>
              You pay for each client workspace, monthly. Every plan has every feature. Your clients
              never pay.
            </p>
          </div>

          <ul className="plans">
            {PLANS.map((plan) => (
              <li key={plan.name} className="plan" data-plan={plan.name}>
                <h2>{plan.name}</h2>
                <p className="aud">{plan.audience}</p>
                <p className="price">
                  <span className="amt">{plan.price}</span>
                  {plan.unit !== null ? <span className="unit">{plan.unit}</span> : null}
                </p>
                <ul className="incl">
                  <li>
                    <Tick />
                    {plan.team}
                  </li>
                  <li>
                    <Tick />
                    {plan.features}
                  </li>
                  <li>
                    <Tick />
                    {plan.clients}
                  </li>
                </ul>
                <a className="btn" href={plan.cta.href}>
                  {plan.cta.label}
                </a>
              </li>
            ))}
          </ul>
          <p className="plans-note">
            Prices in INR. Add as many clients as you like. The trial covers every client you add.
          </p>
        </div>
      </section>

      <section className="close page-close">
        <div className="wrap">
          <h2 className="d">Not sure which plan fits?</h2>
          <p className="sub">
            Start free and pick a plan later, or let us set up your first client with you on a call.
          </p>
          <div className="cta">
            <a className="btn" href={SIGNUP_HREF}>
              Sign up for free
            </a>
            <a className="btn line" href={DEMO_HREF}>
              Book a demo
            </a>
          </div>
          <div className="note">{NOTE}</div>
        </div>
      </section>
    </SiteShell>
  );
}
