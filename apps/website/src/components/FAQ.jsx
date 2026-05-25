import { useState } from 'react';
import './FAQ.css';

const faqs = [
  {
    q: 'What is Donna?',
    a: "Donna is an AI assistant that calls your elderly loved ones as often as you choose. She has warm, natural conversations, delivers reminders, and sends you a summary after every call \u2014 so you always know your parent is okay.",
  },
  {
    q: 'Does Donna sound like a robot?',
    a: "Not at all. Donna uses advanced voice AI that sounds natural and warm. She listens, responds thoughtfully, remembers past conversations, and gets more familiar over time. Most people find her easy and enjoyable to talk to.",
  },
  {
    q: 'What if my parent doesn\'t pick up?',
    a: "If your parent doesn\u2019t pick up, Donna will notify you in the app that the call was missed. You can redial them on Donna\u2019s behalf, and they are also able to call Donna directly. If you don\u2019t want notifications for missed calls, you can disable them in the \u2018Settings\u2019 tab under \u2018Preferences\u2019.",
  },
  {
    q: 'Can I cancel anytime?',
    a: 'Yes, absolutely. There are no contracts or commitments. You can cancel anytime directly from the app.',
  },
  {
    q: 'What does a typical call look like?',
    a: "Calls typically last 1 to 15 minutes. Donna chats about their interests and daily life, delivers any everyday reminders you\u2019ve set, and wraps up warmly. Afterwards, a summary appears in your app. Some seniors just like quick reminders, while others love to chat for hours a week. There\u2019s no right way to use Donna!",
  },
  {
    q: 'How soon can calls start after I download the app?',
    a: "Within minutes of completing setup. You enter your loved one's name, phone number, interests, and preferred call time — and Donna starts calling on the schedule you choose.",
  },
  {
    q: "Is my loved one's information kept private?",
    a: 'We encrypt sensitive information and do not sell personal data. We use service providers only as needed to operate Donna. You can review the privacy policy and third-party services pages at the bottom of this page.',
  },
  {
    q: 'Should I let my parent know I\'m getting Donna for them?',
    a: "Certainly! How would you feel if someone called unannounced and was trying to remind you what to do today \u{1F609}.",
  },
  {
    q: 'What\'s the best way to use Donna?',
    a: "Every family likes to use Donna slightly differently. Some focus on simple reminders and routines. Some treat it like getting a \u2018Siri\u2019 or \u2018Alexa\u2019 their parent can call whenever they like to learn things on the internet. Some seniors like it for companionship. Some seniors enjoy it as entertainment and brain exercise, having fun conversations with an advanced technology made approachable. And many early testers have found other useful ways to get value out of Donna.\n\nThe only right way to use Donna is however it best serves you and your loved one.",
  },
  {
    q: 'My parent is \'tech-challenged\', will this be too complicated?',
    a: "If your parent can answer a phone call, then no! We intentionally designed Donna this way because we want seniors \u2013 those great with technology, those who are curious about technology, and those who don\u2019t even know what an \u2018app\u2019 is \u2013 to all be able to enjoy Donna.\n\nAnd Donna is simple for you, too \u2013 you can manage signup, call times, reminders, etc. all from our mobile app.",
  },
  {
    q: 'How is Donna different from a medical alert system?',
    a: "Donna is not a medical alert system or emergency response service. Donna is for companion calls, everyday conversation, and simple reminders. If someone may be in immediate danger, call emergency services.",
  },
];

function FAQItem({ faq, isOpen, onToggle }) {
  return (
    <div className={`faq__item ${isOpen ? 'faq__item--open' : ''}`}>
      <button className="faq__question" onClick={onToggle} aria-expanded={isOpen}>
        <span>{faq.q}</span>
        <svg
          className="faq__chevron"
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {/* Always render answer in DOM for crawlers; animate visibility for users */}
      <div className="faq__answer-wrapper" style={{ height: isOpen ? 'auto' : 0, opacity: isOpen ? 1 : 0, overflow: 'hidden', transition: 'height 0.3s ease, opacity 0.3s ease' }}>
        <div className="faq__answer">
          {faq.a.split('\n\n').map((para, i) => (
            <p key={i}>{para}</p>
          ))}
        </div>
      </div>
    </div>
  );
}

export default function FAQ() {
  const [openIndex, setOpenIndex] = useState(null);

  return (
    <section className="faq" id="faq">
      <div className="container">
        <div className="faq__header">
          <span className="section-label">Questions?</span>
          <h2 className="section-title">Frequently asked questions</h2>
        </div>

        <div className="faq__list">
          {faqs.map((faq, i) => (
            <FAQItem
              key={i}
              faq={faq}
              isOpen={openIndex === i}
              onToggle={() => setOpenIndex(openIndex === i ? null : i)}
            />
          ))}
        </div>
      </div>
    </section>
  );
}
