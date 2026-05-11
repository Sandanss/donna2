import { useState, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import './Hero.css';

export default function Hero({ onOpenWaitlist }) {
  const [showInfo, setShowInfo] = useState(false);
  const [flipped, setFlipped] = useState(false);
  const swapPhones = useCallback(() => setFlipped(f => !f), []);

  return (
    <section className="hero">
      <div className="hero__inner container">
        <motion.div
          className="hero__content"
          initial={{ opacity: 0, y: 40 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8, ease: 'easeOut' }}
        >
          <h1 className="hero__title">
            A helpful assistant for your parents.{' '}
            <span className="hero__title-accent">Peace of mind for you.</span>
          </h1>
          <p className="hero__subtitle">
            Donna is an AI assistant that calls your loved ones every day — offering warm
            conversation, gentle reminders, and meaningful connection. You get a summary
            after every call, right in the app.
          </p>

          <div className="hero__actions">
            <button
              onClick={onOpenWaitlist}
              className="hero__store-badge hero__store-badge--ios"
              aria-label="Download on the App Store"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                <path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.8-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z"/>
              </svg>
              <div>
                <div className="hero__store-label">Download on the</div>
                <div className="hero__store-name">App Store</div>
              </div>
              <span className="hero__soon-badge">SOON</span>
            </button>
            <a
              href="/signup"
              className="hero__store-badge hero__store-badge--web"
              aria-label="Sign up on our website"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" />
                <line x1="2" y1="12" x2="22" y2="12" />
                <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
              </svg>
              <div>
                <div className="hero__store-label">Sign up on the</div>
                <div className="hero__store-name">Website</div>
              </div>
              <span className="hero__new-badge">NEW</span>
            </a>
          </div>

          <div className="hero__try">
            <a href="tel:+14422121723" className="hero__try-btn">
              <div className="hero__try-icon">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 12 19.79 19.79 0 0 1 1.61 3.4 2 2 0 0 1 3.6 1.22h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L7.91 8.8a16 16 0 0 0 6.29 6.29l.95-.95a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/>
                </svg>
              </div>
              <div className="hero__try-text">
                <span className="hero__try-label">Try Donna right now</span>
                <span className="hero__try-number">(442) 212-1723</span>
              </div>
              <span className="hero__try-arrow">&rarr;</span>
            </a>
            <span className="hero__try-note">
              Want to chat with Donna? Just call and say hello.
              <button
                className="hero__info-btn"
                onClick={() => setShowInfo(true)}
                aria-label="More info about trying Donna"
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                  <circle cx="8" cy="8" r="7" stroke="currentColor" strokeWidth="1.5"/>
                  <text x="8" y="11.5" textAnchor="middle" fill="currentColor" fontSize="10" fontFamily="Inter, sans-serif" fontStyle="italic">i</text>
                </svg>
              </button>
            </span>
          </div>

          <AnimatePresence>
            {showInfo && (
              <motion.div
                className="hero__info-overlay"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.2 }}
                onClick={() => setShowInfo(false)}
              >
                <motion.div
                  className="hero__info-modal"
                  initial={{ opacity: 0, y: 20, scale: 0.95 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: 20, scale: 0.95 }}
                  transition={{ duration: 0.25 }}
                  onClick={(e) => e.stopPropagation()}
                >
                  <button className="hero__info-close" onClick={() => setShowInfo(false)} aria-label="Close">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                  </button>
                  <p>
                    We hope you enjoy meeting Donna! Please note that given we don&apos;t know the names, needs, or interests of unregistered callers, this experience is just a preview of what Donna offers. Once you&apos;re signed up through our app, Donna becomes even more personal and helpful.
                  </p>
                  <p>
                    Unlike other services that force you to pay before getting to try anything, we believe caregivers should get to have a taste of what they are buying. Donna is the top product in the market, and we&apos;re happy to let her speak for herself.
                  </p>
                  <p>
                    We can&apos;t wait for you and your loved one to start getting the most out of everything Donna has to offer! For any questions about where the call transcript goes, please refer to our privacy policy.
                  </p>
                </motion.div>
              </motion.div>
            )}
          </AnimatePresence>
        </motion.div>

        <motion.div
          className="hero__visual"
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.8, delay: 0.2, ease: 'easeOut' }}
        >
          <div className="hero__phone-wrap" onClick={swapPhones} role="button" tabIndex={0} aria-label="Click to swap phone screens" onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') swapPhones(); }}>
            {/* Schedule screen */}
            <motion.div
              className="iphone"
              animate={flipped
                ? { top: 0, left: 0, rotate: -2, zIndex: 2, scale: 1 }
                : { top: 50, right: 0, left: 'auto', rotate: 4, zIndex: 1, scale: 0.95 }
              }
              transition={{ type: 'spring', stiffness: 200, damping: 25 }}
              style={{ position: 'absolute', cursor: 'pointer' }}
            >
              <div className="iphone__frame">
                <div className="iphone__status-bar">
                  <span className="iphone__time">9:41</span>
                  <div className="iphone__dynamic-island" />
                  <div className="iphone__status-icons">
                    <svg className="iphone__signal" width="17" height="12" viewBox="0 0 17 12"><rect x="0" y="8" width="3" height="4" rx="0.5" fill="currentColor"/><rect x="4.5" y="5" width="3" height="7" rx="0.5" fill="currentColor"/><rect x="9" y="2" width="3" height="10" rx="0.5" fill="currentColor"/><rect x="13.5" y="0" width="3" height="12" rx="0.5" fill="currentColor" opacity="0.3"/></svg>
                    <svg className="iphone__wifi" width="16" height="12" viewBox="0 0 16 12"><path d="M8 10.5a1.5 1.5 0 110 3 1.5 1.5 0 010-3z" fill="currentColor"/><path d="M4.46 8.04a5 5 0 017.08 0" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" fill="none"/><path d="M1.4 5a9 9 0 0113.2 0" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" fill="none"/></svg>
                    <div className="iphone__battery">
                      <div className="iphone__battery-body"><div className="iphone__battery-fill" /></div>
                      <div className="iphone__battery-cap" />
                    </div>
                  </div>
                </div>
                <div className="iphone__screen">
                  <img src="/images/screen-schedule.jpg" alt="Donna app schedule screen showing daily calls and reminders" />
                </div>
                <div className="iphone__home-bar" />
              </div>
            </motion.div>

            {/* Dashboard screen */}
            <motion.div
              className="iphone"
              animate={flipped
                ? { top: 50, right: 0, left: 'auto', rotate: 4, zIndex: 1, scale: 0.95 }
                : { top: 0, left: 0, rotate: -2, zIndex: 2, scale: 1 }
              }
              transition={{ type: 'spring', stiffness: 200, damping: 25 }}
              style={{ position: 'absolute', cursor: 'pointer' }}
            >
              <div className="iphone__frame">
                <div className="iphone__status-bar">
                  <span className="iphone__time">9:41</span>
                  <div className="iphone__dynamic-island" />
                  <div className="iphone__status-icons">
                    <svg className="iphone__signal" width="17" height="12" viewBox="0 0 17 12"><rect x="0" y="8" width="3" height="4" rx="0.5" fill="currentColor"/><rect x="4.5" y="5" width="3" height="7" rx="0.5" fill="currentColor"/><rect x="9" y="2" width="3" height="10" rx="0.5" fill="currentColor"/><rect x="13.5" y="0" width="3" height="12" rx="0.5" fill="currentColor"/></svg>
                    <svg className="iphone__wifi" width="16" height="12" viewBox="0 0 16 12"><path d="M8 10.5a1.5 1.5 0 110 3 1.5 1.5 0 010-3z" fill="currentColor"/><path d="M4.46 8.04a5 5 0 017.08 0" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" fill="none"/><path d="M1.4 5a9 9 0 0113.2 0" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" fill="none"/></svg>
                    <div className="iphone__battery">
                      <div className="iphone__battery-body"><div className="iphone__battery-fill" /></div>
                      <div className="iphone__battery-cap" />
                    </div>
                  </div>
                </div>
                <div className="iphone__screen">
                  <img src="/images/screen-dashboard.jpg" alt="Donna app dashboard showing call history and next scheduled call" />
                </div>
                <div className="iphone__home-bar" />
              </div>
            </motion.div>
          </div>
        </motion.div>
      </div>
    </section>
  );
}
