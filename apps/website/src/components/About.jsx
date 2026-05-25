import { motion } from 'framer-motion';
import './About.css';

export default function About() {
  return (
    <section className="about" id="about">
      <div className="container">
        <div className="about__header">
          <span className="section-label">Our Story</span>
          <h2 className="section-title">Built from a personal need.</h2>
        </div>

        <div className="about__inner">
          <motion.div
            className="about__content"
            initial={{ opacity: 0, x: -40 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true, margin: '-100px' }}
            transition={{ duration: 0.6 }}
          >
            <p className="about__text">
              We&apos;re Nick &amp; David, the founders of Donna. We built Donna because we know
              firsthand how hard it is to make sure nothing slips through the cracks when
              you&apos;re helping take care of an aging loved one. Primary caregivers have so
              much on their plates — coordinating schedules,
              managing their paperwork and finances, decluttering their houses — all while
              trying to keep up their core relationship with their loved one. Not a
              relationship as a chauffeur or accountant or maid or all of the above. But as
              a child, a spouse, or other family member or dear friend.
            </p>
            <p className="about__text">
              With all those big responsibilities, we&apos;ve seen how smaller things get missed.
              Maybe the plants don&apos;t get watered, maybe a favorite sports team&apos;s game
              doesn&apos;t get watched, maybe the doors don&apos;t get locked at night. We built Donna
              to help. Donna can never replace your efforts as a caregiver, and Donna can
              certainly never replace your core relationship. But for many families already,
              Donna serves as a helpful assistant that gives your loved one an extra layer of
              support and care.
            </p>

            <div className="about__story-highlight">
              <span className="about__story-label">⭐ Proudest Donna moment</span>
              <p>
                Nick&apos;s grandpa is an avid Detroit Tigers baseball fan. They play 162 games
                per year, and if anyone has time to watch them all, it&apos;s him. However, game
                times vary by day and he often used to miss them. But Donna never misses them.
                Now he gets a call 10 minutes before every Tigers game starts — so he
                hasn&apos;t missed a pitch since.
              </p>
            </div>

            <div className="about__trust">
              <a
                href="http://www.linkedin.com/in/nicholas-mehdi"
                target="_blank"
                rel="noopener noreferrer"
                className="about__linkedin"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 0 1-2.063-2.065 2.064 2.064 0 1 1 2.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z" />
                </svg>
                Connect on LinkedIn
              </a>
            </div>
          </motion.div>

          <motion.div
            className="about__photos"
            initial={{ opacity: 0, x: 40 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true, margin: '-100px' }}
            transition={{ duration: 0.6, delay: 0.15 }}
          >
            <div className="about__photo-card">
              <img src="/images/nick-grandpa.jpg" alt="Nick and his grandpa watching a sunset" />
              <p className="about__photo-caption">Nick and his grandpa watching a sunset</p>
            </div>
            <div className="about__photo-card about__photo-card--offset">
              <img src="/images/david-grandma.png" alt="David and his grandma catching a race" />
              <p className="about__photo-caption">David and his grandma catching a race</p>
            </div>
          </motion.div>
        </div>
      </div>
    </section>
  );
}
