import { motion } from 'framer-motion';
import './Timeline.css';

const setupSteps = [
  {
    number: '1',
    title: 'Download the app',
    description: <>Available on iOS. Free to download. You can also sign up <a href="/signup" className="setup__link">here</a>.</>,
  },
  {
    number: '2',
    title: 'Sign up',
    description: "Create an account and tell us the best times to call, reminders you want Donna to give, and your loved one\u2019s interests.",
  },
  {
    number: '3',
    title: "You're all set",
    description: "That's it. Donna will call on schedule, and you'll get updates and call summaries right in the app and on this site.",
  },
];

const events = [
  {
    time: '10:00 AM',
    title: 'Donna calls Mom',
    description: '"Good morning, Margaret! How are you feeling today? Did you have breakfast yet?"',
    icon: '📞',
  },
  {
    time: '10:05 AM',
    title: 'Warm conversation',
    description: 'A natural chat about her garden, her favorite shows, recent news — whatever she loves to talk about.',
    icon: '💬',
  },
  {
    time: '10:15 AM',
    title: 'Call wraps up',
    description: "Donna gently wraps up, delivers any reminders you've set, and says goodbye until next time.",
    icon: '✅',
  },
  {
    time: '10:16 AM',
    title: 'You get a summary',
    description: '"Your mom is doing great this morning. She already ate her breakfast and mentioned she\'s going to spend some time tending to her garden. I reminded her to bring the mail in as usual. My next call is scheduled for 8:00 PM tonight."',
    icon: '📱',
  },
];

export default function Timeline() {
  return (
    <section className="timeline" id="how-it-works">
      <div className="container">
        {/* ── Get Set Up ── */}
        <div className="timeline__header">
          <span className="section-label">How It Works</span>
          <h2 className="section-title">Get set up in 5 minutes</h2>
          <p className="section-subtitle">
            Easy for you. Even easier for your loved one.
          </p>
        </div>

        <div className="setup__steps">
          {setupSteps.map((step, i) => (
            <motion.div
              key={i}
              className="setup__card"
              initial={{ opacity: 0, y: 30 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: '-80px' }}
              transition={{ duration: 0.5, delay: i * 0.15 }}
            >
              <div className="setup__number">{step.number}</div>
              <h3 className="setup__title">{step.title}</h3>
              <p className="setup__desc">{step.description}</p>
            </motion.div>
          ))}
        </div>

        {/* ── A Day in the Life ── */}
        <div className="timeline__header timeline__header--second">
          <h2 className="section-title">A day in the life with Donna</h2>
          <p className="section-subtitle">
            Every day, your loved one gets a warm, personal call from Donna. You get peace of mind.
          </p>
        </div>

        <div className="timeline__track">
          <div className="timeline__line" />
          {events.map((event, i) => (
            <motion.div
              key={i}
              className="timeline__event"
              initial={{ opacity: 0, x: i % 2 === 0 ? -40 : 40 }}
              whileInView={{ opacity: 1, x: 0 }}
              viewport={{ once: true, margin: '-100px' }}
              transition={{ duration: 0.6, delay: i * 0.15 }}
            >
              <div className="timeline__dot">
                <span className="timeline__icon">{event.icon}</span>
              </div>
              <div className="timeline__card">
                <span className="timeline__time">{event.time}</span>
                <h3 className="timeline__card-title">{event.title}</h3>
                <p className="timeline__card-desc">{event.description}</p>
              </div>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}
