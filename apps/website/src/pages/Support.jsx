import './LegalPage.css';

export default function Support() {
  return (
    <section className="legal-page">
      <div className="legal-page__container">
        <div className="legal-page__header">
          <h1 className="legal-page__title">Support</h1>
          <p className="legal-page__meta">Last Updated: April 22, 2026</p>
        </div>

        <div className="legal-page__body">
          <h2>Contact Donna</h2>
          <p>Email <a href="mailto:support@calldonna.co">support@calldonna.co</a> for account help, onboarding questions, privacy requests, cancellation requests, or app support.</p>

          <h2>Privacy-Safe Support</h2>
          <p>Please avoid sending medical details, full transcripts, medication lists, or other sensitive information by email unless we specifically ask for the minimum details needed to resolve your request.</p>

          <h2>Account and App Help</h2>
          <p>For sign-in, setup, schedule, reminder, or call summary issues, email us with your account email and a short description of the problem. Do not include medical details in support messages unless we specifically ask for them.</p>

          <h2>Stop or Pause Calls</h2>
          <p>You can stop scheduled calls in the Donna app. If you cannot access the app, email us from the caregiver account email and we will help verify the account before making changes.</p>

          <h2>Account Deletion</h2>
          <p>You can request account deletion from the Donna app. If you cannot access the app, email us from the caregiver account email and we will help verify and process the request.</p>

          <h2>Billing and Cancellation</h2>
          <p>For billing, subscription, cancellation, or refund questions, email us from the account email used for Donna.</p>

          <h2>Urgent Situations</h2>
          <p>Donna is not an emergency response service. If someone may be in immediate danger, call 911 or local emergency services.</p>
        </div>
      </div>
    </section>
  );
}
