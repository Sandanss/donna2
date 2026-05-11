import { motion } from 'framer-motion';
import './Pricing.css';

export default function Pricing({ onOpenWaitlist }) {
  return (
    <section className="pricing" id="pricing">
      <div className="container">
        <div className="pricing__header">
          <span className="section-label">Simple Pricing</span>
          <h2 className="section-title">Less than $1 a day</h2>
          <p className="section-subtitle">
            One plan. Everything included. No hidden fees.
          </p>
        </div>

        <motion.div
          className="pricing__card"
          initial={{ opacity: 0, y: 40 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-50px' }}
          transition={{ duration: 0.6 }}
        >
          <div className="pricing__badge">Most Popular</div>
          <div className="pricing__price">
            <span className="pricing__amount">$19</span>
            <span className="pricing__period">/month</span>
          </div>
          <p className="pricing__tagline">That&apos;s less than $1 per day for peace of mind.</p>

          <ul className="pricing__features">
            <li>
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M13.3 4.7L6.5 11.5L2.7 7.7" stroke="#5F7464" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
              Unlimited calls with Donna
            </li>
            <li>
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M13.3 4.7L6.5 11.5L2.7 7.7" stroke="#5F7464" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
              Full reminders functionality
            </li>
            <li>
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M13.3 4.7L6.5 11.5L2.7 7.7" stroke="#5F7464" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
              Web Search
            </li>
            <li>
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M13.3 4.7L6.5 11.5L2.7 7.7" stroke="#5F7464" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
              Post-call summaries in the app
            </li>
            <li>
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M13.3 4.7L6.5 11.5L2.7 7.7" stroke="#5F7464" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
              Instant alerts if calls are missed
            </li>
            <li>
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M13.3 4.7L6.5 11.5L2.7 7.7" stroke="#5F7464" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
              Cancel anytime — no contracts
            </li>
          </ul>

          <div className="pricing__cta-group">
            <button onClick={onOpenWaitlist} className="btn btn-primary pricing__cta pricing__cta--ios">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                <path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.8-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z"/>
              </svg>
              Download on iOS
              <span className="pricing__tag">Soon</span>
            </button>
            <a href="/signup" className="btn pricing__cta pricing__cta--web">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" />
                <line x1="2" y1="12" x2="22" y2="12" />
                <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
              </svg>
              Sign up on Website
              <span className="pricing__tag">New</span>
            </a>
          </div>
        </motion.div>
      </div>
    </section>
  );
}
