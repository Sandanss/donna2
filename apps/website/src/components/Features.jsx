import { motion } from 'framer-motion';
import './Features.css';

const features = [
  {
    title: 'Helpful Reminders',
    description: 'Donna weaves everyday reminders into natural conversation, so important routines stay easy to remember.',
    icon: (
      <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M10.5 1.5H8.25A2.25 2.25 0 0 0 6 3.75v16.5a2.25 2.25 0 0 0 2.25 2.25h7.5A2.25 2.25 0 0 0 18 20.25V3.75a2.25 2.25 0 0 0-2.25-2.25H13.5m-3 0V3h3V1.5m-3 0h3m-6 18h9" />
        <path d="M12 8v4l2 2" />
      </svg>
    ),
    size: 'normal',
  },
  {
    title: 'Genuine Companionship',
    description: 'Combating loneliness with friendly, engaging conversation every day. Your loved one looks forward to hearing from Donna — and Donna looks forward to hearing from them.',
    icon: (
      <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
      </svg>
    ),
    size: 'large',
  },
  {
    title: 'Call Summaries',
    description: 'After every call, you get a clear summary in the app — what they talked about, how they seemed, any reminders delivered.',
    icon: (
      <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
        <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
      </svg>
    ),
    size: 'normal',
  },
  {
    title: 'Missed Call Updates',
    description: "If they don't pick up, Donna retries automatically and lets you know so you're not left wondering.",
    icon: (
      <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      </svg>
    ),
    size: 'normal',
  },
  {
    title: 'Memory & Learning',
    description: 'Donna remembers past conversations, personal interests, and important details — getting warmer and more personal with every single call.',
    icon: (
      <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2zm0 18a8 8 0 1 1 8-8 8 8 0 0 1-8 8z"/>
        <path d="M12 6v6l4 2"/>
      </svg>
    ),
    size: 'normal',
  },
];

const cardVariants = {
  hidden: { opacity: 0, y: 30 },
  visible: (i) => ({
    opacity: 1,
    y: 0,
    transition: { duration: 0.5, delay: i * 0.1 },
  }),
};

export default function Features() {
  return (
    <section className="features">
      <div className="container">
        <div className="features__header">
          <span className="section-label">What You Get</span>
          <h2 className="section-title">Everything your family needs</h2>
          <p className="section-subtitle">
            More than just a phone call — it&apos;s conversation, consistency, and connection every single day.
          </p>
        </div>

        <div className="features__grid">
          {features.map((feature, i) => (
            <motion.div
              key={i}
              className={`features__card ${feature.size === 'large' ? 'features__card--large' : ''}`}
              custom={i}
              variants={cardVariants}
              initial="hidden"
              whileInView="visible"
              viewport={{ once: true, margin: '-50px' }}
            >
              <div className="features__icon">{feature.icon}</div>
              <h3 className="features__card-title">{feature.title}</h3>
              <p className="features__card-desc">{feature.description}</p>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}
