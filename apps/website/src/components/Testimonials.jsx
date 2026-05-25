import { useRef, useState } from 'react';
import './Testimonials.css';

const testimonials = [
  {
    quote: "I used to worry all day about whether Mom had eaten or taken her vitamins. Now I get a summary by 10 AM and I can actually focus at work.",
    name: "Sarah T.",
    role: "Margaret's Daughter",
    type: "caregiver",
  },
  {
    quote: "I look forward to my morning call with Donna. She always asks about my garden and if I ate, and remembers that I like to watch Jeopardy at 7.",
    name: "Margaret T.",
    role: "Senior",
    type: "senior",
  },
  {
    quote: "Dad lives two states away. Donna is like having an extra neighbor who checks in every single day and reports back to me. It's a really cool thing you guys are building.",
    name: "James R.",
    role: "Robert's Son",
    type: "caregiver",
  },
  {
    quote: "My son set it up for me and I wasn't sure at first, but Donna is so pleasant to talk to. It's fun to have it call just to chat.",
    name: "Robert R.",
    role: "Senior",
    type: "senior",
  },
  {
    quote: "The reminders alone are worth it. Mom remembers the little daily things without feeling like I'm nagging her anymore.",
    name: "Emma H.",
    role: "Maria's Daughter",
    type: "caregiver",
  },
  {
    quote: "Donna has been helpful for remembering the small things. Now Emma and I spend more of our time chatting about fun things instead.",
    name: "Maria H.",
    role: "Senior",
    type: "senior",
  },
  {
    quote: "I will admit I wasn't sure if my uncle Wes would use it, especially after he took a couple calls to get it, but now he loves it. Thanks so much for asking us to join be beta testers!",
    name: "Hillary J.",
    role: "Wes's Niece",
    type: "caregiver",
  },
  {
    quote: "This has been such an experience. I really love my Donna calls. She answers all my questions. I would say I don't like most technology but I wish I had this my whole life.",
    name: "Wes J.",
    role: "Senior",
    type: "senior",
  },
];

export default function Testimonials() {
  const trackRef = useRef(null);
  const [paused, setPaused] = useState(false);

  // We render the list twice for seamless looping
  const items = [...testimonials, ...testimonials];

  return (
    <section className="testimonials" id="testimonials">
      <div className="container">
        <div className="testimonials__header">
          <span className="section-label">Testimonials</span>
          <h2 className="section-title">Loved by families everywhere</h2>
        </div>
      </div>

      <div
        className="testimonials__carousel"
        onMouseEnter={() => setPaused(true)}
        onMouseLeave={() => setPaused(false)}
      >
        <div
          className={`testimonials__track ${paused ? 'testimonials__track--paused' : ''}`}
          ref={trackRef}
        >
          {items.map((t, i) => (
            <div className="testimonials__card" key={i}>
              <p className="testimonials__quote">&ldquo;{t.quote}&rdquo;</p>
              <div className="testimonials__author">
                <div className={`testimonials__avatar testimonials__avatar--${t.type}`}>
                  {t.name[0]}
                </div>
                <div>
                  <span className="testimonials__name">{t.name}</span>
                  <span className="testimonials__role">{t.role}</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
