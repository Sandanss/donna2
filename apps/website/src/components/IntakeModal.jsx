import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import './IntakeModal.css';

const CALL_WINDOWS = [
  '8:00 AM - 9:00 AM',
  '9:00 AM - 10:00 AM',
  '10:00 AM - 11:00 AM',
  '11:00 AM - 12:00 PM',
  '1:00 PM - 2:00 PM',
  '2:00 PM - 3:00 PM',
];

export default function IntakeModal({ isOpen, onClose }) {
  const [form, setForm] = useState({
    caregiverName: '',
    caregiverEmail: '',
    seniorName: '',
    seniorPhone: '',
    callWindow: '',
  });
  const [submitted, setSubmitted] = useState(false);

  const handleChange = (e) => {
    setForm({ ...form, [e.target.name]: e.target.value });
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    // TODO: Wire up Stripe payment + form submission (EmailJS / API)
    setSubmitted(true);
  };

  const handleClose = () => {
    setSubmitted(false);
    setForm({ caregiverName: '', caregiverEmail: '', seniorName: '', seniorPhone: '', callWindow: '' });
    onClose();
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          className="modal-overlay"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={handleClose}
        >
          <motion.div
            className="modal"
            initial={{ opacity: 0, y: 40, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 40, scale: 0.95 }}
            transition={{ duration: 0.3 }}
            onClick={(e) => e.stopPropagation()}
          >
            <button className="modal__close" onClick={handleClose} aria-label="Close">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>

            {!submitted ? (
              <>
                <h2 className="modal__title">Start Daily Calls</h2>
                <p className="modal__subtitle">
                  Fill in the details below and we&apos;ll get your loved one set up within 24 hours.
                </p>

                <form className="modal__form" onSubmit={handleSubmit}>
                  <div className="modal__form-group">
                    <label htmlFor="caregiverName">Your Name</label>
                    <input
                      id="caregiverName"
                      name="caregiverName"
                      type="text"
                      placeholder="Jane Doe"
                      value={form.caregiverName}
                      onChange={handleChange}
                      required
                    />
                  </div>

                  <div className="modal__form-group">
                    <label htmlFor="caregiverEmail">Your Email</label>
                    <input
                      id="caregiverEmail"
                      name="caregiverEmail"
                      type="email"
                      placeholder="jane@example.com"
                      value={form.caregiverEmail}
                      onChange={handleChange}
                      required
                    />
                  </div>

                  <div className="modal__form-group">
                    <label htmlFor="seniorName">Senior&apos;s Name</label>
                    <input
                      id="seniorName"
                      name="seniorName"
                      type="text"
                      placeholder="Mary Doe"
                      value={form.seniorName}
                      onChange={handleChange}
                      required
                    />
                  </div>

                  <div className="modal__form-group">
                    <label htmlFor="seniorPhone">Senior&apos;s Phone Number</label>
                    <input
                      id="seniorPhone"
                      name="seniorPhone"
                      type="tel"
                      placeholder="(555) 123-4567"
                      value={form.seniorPhone}
                      onChange={handleChange}
                      required
                    />
                  </div>

                  <div className="modal__form-group">
                    <label htmlFor="callWindow">Preferred Call Window</label>
                    <select
                      id="callWindow"
                      name="callWindow"
                      value={form.callWindow}
                      onChange={handleChange}
                      required
                    >
                      <option value="">Select a time...</option>
                      {CALL_WINDOWS.map((w) => (
                        <option key={w} value={w}>{w}</option>
                      ))}
                    </select>
                  </div>

                  {/* Stripe placeholder */}
                  <div className="modal__stripe-placeholder">
                    <div className="modal__stripe-label">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <rect x="1" y="4" width="22" height="16" rx="2" ry="2" />
                        <line x1="1" y1="10" x2="23" y2="10" />
                      </svg>
                      Payment Details
                    </div>
                    <div className="modal__stripe-box">
                      <span>Stripe payment form will appear here</span>
                      <span className="modal__stripe-amount">$30/month</span>
                    </div>
                  </div>

                  <button type="submit" className="btn btn-gold modal__submit">
                    Subscribe &mdash; $30/month
                  </button>

                  <p className="modal__disclaimer">
                    Cancel anytime. No contracts or commitments. Your card will be charged $30 monthly.
                  </p>
                </form>
              </>
            ) : (
              <div className="modal__success">
                <div className="modal__success-icon">
                  <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#5F7464" strokeWidth="2">
                    <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                    <polyline points="22 4 12 14.01 9 11.01" />
                  </svg>
                </div>
                <h2 className="modal__title">Welcome to Donna!</h2>
                <p className="modal__subtitle">
                  Thank you for signing up. Nicholas will reach out within 24 hours to
                  introduce himself and schedule the first call with {form.seniorName || 'your loved one'}.
                </p>
                <button className="btn btn-primary" onClick={handleClose}>
                  Done
                </button>
              </div>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
