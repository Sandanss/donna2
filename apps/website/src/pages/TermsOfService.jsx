import './LegalPage.css';

export default function TermsOfService() {
  return (
    <section className="legal-page">
      <div className="legal-page__container">
        <div className="legal-page__header">
          <h1 className="legal-page__title">Terms of Service</h1>
          <p className="legal-page__meta">Effective Date: March 28, 2026 &nbsp;·&nbsp; Last Updated: May 25, 2026</p>
        </div>

        <div className="legal-page__body">
          <h2>1. Agreement to Terms</h2>
          <p>These Terms of Service (&ldquo;Terms&rdquo;) constitute a legally binding agreement between you (&ldquo;you,&rdquo; &ldquo;your,&rdquo; or &ldquo;Subscriber&rdquo;) and Donna, operated by Nicholas Mehdi (&ldquo;Donna,&rdquo; &ldquo;we,&rdquo; &ldquo;us,&rdquo; or &ldquo;our&rdquo;). By creating an account, subscribing to our service, or using the Donna application or website located at calldonna.co (&ldquo;Service&rdquo;), you agree to be bound by these Terms in full.</p>
          <p>If you do not agree to these Terms, do not use the Service. We reserve the right to update these Terms at any time. Material changes will be communicated via email or in-app notice at least 30 days before taking effect. Your continued use of the Service after the effective date of any update constitutes acceptance of the revised Terms.</p>

          <h2>2. Description of Service</h2>
          <p>Donna is an AI-powered companion calling service. Through the Donna mobile application and web platform, caregivers (&ldquo;Subscribers&rdquo;) can schedule automated, personalized phone calls from an AI assistant (&ldquo;Donna&rdquo;) to their elderly loved ones (&ldquo;Call Recipients&rdquo;). The Service includes:</p>
          <ul>
            <li>Scheduled AI-generated phone calls to Call Recipients</li>
            <li>Personalized conversation based on preferences, interests, and reminders configured by the Subscriber</li>
            <li>Post-call summaries and transcripts delivered to the Subscriber</li>
            <li>Missed call notifications and call history</li>
            <li>A preview phone line for prospective users to experience a sample call without an account</li>
          </ul>
          <div className="legal-page__notice">
            <strong>Important:</strong> Donna is not a medical device, emergency service, or substitute for professional healthcare. Donna does not provide medical advice, diagnose conditions, or monitor health. If the Call Recipient experiences a medical emergency, call 911 or your local emergency number.
          </div>

          <h2>3. Eligibility</h2>
          <p>You must be at least 18 years of age and capable of forming a binding contract to use the Service. By subscribing, you represent that:</p>
          <ol>
            <li>You are at least 18 years of age</li>
            <li>You have the legal authority to agree to these Terms</li>
            <li>You have obtained appropriate consent from the Call Recipient (or their legal guardian or authorized representative) to receive AI-generated phone calls from Donna</li>
            <li>All information you provide is accurate, current, and complete</li>
          </ol>

          <h2>4. Account Registration and Security</h2>
          <p>To access the Service, you must create an account and provide accurate information including your name, email address, and payment details. You are solely responsible for:</p>
          <ul>
            <li>Maintaining the confidentiality of your account credentials</li>
            <li>All activity that occurs under your account</li>
            <li>Notifying us immediately at <a href="mailto:support@calldonna.co">support@calldonna.co</a> if you suspect unauthorized access</li>
          </ul>
          <p>We reserve the right to suspend or terminate accounts that we reasonably believe have been compromised or are being used in violation of these Terms.</p>

          <h2>5. Consent for AI-Generated Calls (TCPA Compliance)</h2>
          <p>The Service uses artificial intelligence and automated telephone dialing technology to place calls to Call Recipients. Under the Telephone Consumer Protection Act (TCPA), 47 U.S.C. &sect; 227, prior express consent is required before placing automated calls to any telephone number.</p>
          <p>By subscribing to Donna and providing a Call Recipient&apos;s phone number, you expressly represent and warrant that:</p>
          <ol>
            <li>You have obtained the Call Recipient&apos;s prior express consent (or the consent of their legal guardian or authorized representative) to receive AI-generated, automated telephone calls from Donna at the number provided</li>
            <li>You have informed the Call Recipient that the calls will be placed by an AI system, not a human</li>
            <li>You have the legal authority to provide this consent on behalf of the Call Recipient</li>
            <li>You will promptly notify Donna if the Call Recipient revokes their consent or requests that calls cease</li>
          </ol>
          <p>You agree to indemnify and hold Donna harmless from any claims, damages, or penalties arising from your failure to obtain proper consent. Call Recipients (or their Subscriber) may request to stop receiving calls at any time by contacting <a href="mailto:support@calldonna.co">support@calldonna.co</a> or by managing settings in the app.</p>

          <h2>6. Subscription, Pricing, and Payment</h2>
          <h3>6.1 Subscription Plans</h3>
          <p>The Service is offered on a monthly subscription basis at the price displayed at the time of purchase (currently $19.00 per month). Prices are subject to change with at least 30 days&apos; written notice to active Subscribers.</p>
          <h3>6.2 Billing</h3>
          <p>Subscription fees are billed in advance on a recurring monthly basis starting from the date of your initial subscription. Payment is processed through our third-party payment processor (currently Stripe). You authorize us to charge the payment method on file for all applicable fees.</p>
          <h3>6.3 Failed Payments</h3>
          <p>If a payment fails, we will attempt to process it again and notify you by email. If payment is not resolved within 7 days, we reserve the right to suspend the Service until the balance is settled.</p>
          <h3>6.4 Refunds</h3>
          <p>Subscription fees are generally non-refundable. However, if you are dissatisfied with the Service within the first 14 days of your initial subscription, you may request a full refund by contacting <a href="mailto:support@calldonna.co">support@calldonna.co</a>. Refund requests after this period will be considered on a case-by-case basis at our sole discretion.</p>

          <h2>7. Cancellation</h2>
          <p>You may cancel your subscription at any time through the app or by contacting <a href="mailto:support@calldonna.co">support@calldonna.co</a>. Upon cancellation:</p>
          <ul>
            <li>Your subscription will remain active through the end of the current billing period</li>
            <li>No further charges will be incurred after the current period</li>
            <li>All scheduled calls will cease at the end of the billing period</li>
            <li>Your account data will be retained for 90 days, after which it will be deleted in accordance with our Privacy Policy</li>
          </ul>

          <h2>8. Acceptable Use</h2>
          <p>You agree not to use the Service to:</p>
          <ul>
            <li>Provide false, misleading, or fraudulent information</li>
            <li>Harass, abuse, or harm any person, including Call Recipients</li>
            <li>Schedule calls to numbers you are not authorized to contact</li>
            <li>Use the Service for any unlawful, deceptive, or malicious purpose</li>
            <li>Attempt to reverse-engineer, decompile, or extract the source code of any part of the Service</li>
            <li>Interfere with or disrupt the integrity or performance of the Service</li>
            <li>Resell, sublicense, or redistribute access to the Service without our written consent</li>
          </ul>
          <p>Violation of these provisions may result in immediate suspension or termination of your account without refund.</p>

          <h2>9. Intellectual Property</h2>
          <p>All content, software, technology, branding, trademarks, and materials associated with the Service (&ldquo;Donna IP&rdquo;) are owned by or licensed to Donna and are protected by applicable intellectual property laws. You are granted a limited, non-exclusive, non-transferable, revocable license to use the Service for its intended purpose during your active subscription.</p>
          <p>You retain ownership of any personal content you submit (e.g., information about your loved one). By submitting such content, you grant us a limited license to use it solely for the purposes of operating, personalizing, and improving the Service, as described in our Privacy Policy.</p>

          <h2>10. Preview Phone Line</h2>
          <p>Donna offers a preview phone line that allows prospective users to experience a sample AI-generated call without creating an account. By calling the preview line, you acknowledge that:</p>
          <ul>
            <li>The call is with an AI system, not a human</li>
            <li>The experience is a limited preview and does not reflect the full personalized service available to Subscribers</li>
            <li>The call may be transcribed or analyzed to operate and improve Donna; recordings are not used by default unless separately enabled or disclosed</li>
            <li>No personal information will be stored beyond the duration needed for call processing unless you subsequently create an account</li>
          </ul>

          <h2>11. Disclaimer of Warranties</h2>
          <p>THE SERVICE IS PROVIDED &ldquo;AS IS&rdquo; AND &ldquo;AS AVAILABLE,&rdquo; WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO IMPLIED WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, AND NON-INFRINGEMENT.</p>
          <p>Without limiting the foregoing, Donna does not warrant that:</p>
          <ul>
            <li>The Service will be uninterrupted, error-free, or completely secure</li>
            <li>AI-generated calls will be perfectly accurate, appropriate, or free from errors in every instance</li>
            <li>The Service will meet your specific requirements or expectations</li>
            <li>Call quality or connectivity will be guaranteed, as these depend on third-party telecommunications infrastructure</li>
          </ul>

          <h2>12. Limitation of Liability</h2>
          <p>TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW, DONNA, ITS OWNERS, OFFICERS, EMPLOYEES, AND AGENTS SHALL NOT BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR PUNITIVE DAMAGES, INCLUDING BUT NOT LIMITED TO LOSS OF PROFITS, DATA, OR GOODWILL, ARISING OUT OF OR IN CONNECTION WITH YOUR USE OF THE SERVICE, REGARDLESS OF THE THEORY OF LIABILITY.</p>
          <p>OUR TOTAL AGGREGATE LIABILITY FOR ANY CLAIMS ARISING FROM OR RELATED TO THESE TERMS OR THE SERVICE SHALL NOT EXCEED THE TOTAL AMOUNT YOU PAID TO DONNA IN THE THREE (3) MONTHS PRECEDING THE EVENT GIVING RISE TO THE CLAIM.</p>
          <p>Some jurisdictions do not allow the exclusion or limitation of certain warranties or liabilities. In such cases, our liability will be limited to the fullest extent permitted by applicable law.</p>

          <h2>13. Indemnification</h2>
          <p>You agree to indemnify, defend, and hold harmless Donna, its owners, employees, contractors, and agents from and against any and all claims, liabilities, damages, losses, costs, and expenses (including reasonable attorneys&apos; fees) arising out of or relating to:</p>
          <ul>
            <li>Your use of the Service</li>
            <li>Your breach of these Terms</li>
            <li>Your failure to obtain proper consent from a Call Recipient</li>
            <li>Any content or information you provide through the Service</li>
            <li>Any dispute between you and a Call Recipient regarding the Service</li>
          </ul>

          <h2>14. Termination</h2>
          <p>We may suspend or terminate your access to the Service at any time, with or without cause, and with or without notice, including but not limited to cases of:</p>
          <ul>
            <li>Violation of these Terms or our Acceptable Use policy</li>
            <li>Non-payment of subscription fees</li>
            <li>Conduct that we reasonably believe is harmful to other users, Call Recipients, or Donna</li>
            <li>Requests from law enforcement or government agencies</li>
          </ul>
          <p>Upon termination, your right to use the Service ceases immediately. Sections 9, 11, 12, 13, 15, and 16 shall survive termination.</p>

          <h2>15. Governing Law and Dispute Resolution</h2>
          <p>These Terms shall be governed by and construed in accordance with the laws of the State of Michigan, without regard to conflict of law principles.</p>
          <h3>15.1 Informal Resolution</h3>
          <p>Before initiating any formal dispute resolution, you agree to contact us at <a href="mailto:support@calldonna.co">support@calldonna.co</a> and attempt to resolve the dispute informally for at least 30 days.</p>
          <h3>15.2 Binding Arbitration</h3>
          <p>If informal resolution fails, any dispute, claim, or controversy arising out of or relating to these Terms or the Service shall be resolved by binding arbitration administered by the American Arbitration Association (&ldquo;AAA&rdquo;) under its Consumer Arbitration Rules. The arbitration shall be conducted in the State of Michigan. Judgment on the arbitration award may be entered in any court of competent jurisdiction.</p>
          <h3>15.3 Class Action Waiver</h3>
          <p>YOU AND DONNA AGREE THAT EACH MAY BRING CLAIMS AGAINST THE OTHER ONLY IN YOUR OR OUR INDIVIDUAL CAPACITY AND NOT AS A PLAINTIFF OR CLASS MEMBER IN ANY PURPORTED CLASS, CONSOLIDATED, OR REPRESENTATIVE ACTION.</p>

          <h2>16. General Provisions</h2>
          <h3>16.1 Entire Agreement</h3>
          <p>These Terms, together with our Privacy Policy, constitute the entire agreement between you and Donna regarding the Service and supersede all prior or contemporaneous agreements, communications, and proposals.</p>
          <h3>16.2 Severability</h3>
          <p>If any provision of these Terms is found to be unenforceable, the remaining provisions shall continue in full force and effect.</p>
          <h3>16.3 Waiver</h3>
          <p>Our failure to enforce any provision of these Terms shall not be deemed a waiver of that provision or of our right to enforce it in the future.</p>
          <h3>16.4 Assignment</h3>
          <p>You may not assign or transfer your rights or obligations under these Terms without our prior written consent. We may assign our rights and obligations without restriction.</p>
          <h3>16.5 Force Majeure</h3>
          <p>Donna shall not be liable for any failure or delay in performance due to circumstances beyond our reasonable control, including but not limited to acts of God, natural disasters, pandemics, telecommunications failures, government actions, or third-party service outages.</p>

          <h2>17. Contact Us</h2>
          <p>If you have questions about these Terms of Service, please contact us:</p>
          <p>
            <strong>Donna</strong><br />
            Email: <a href="mailto:support@calldonna.co">support@calldonna.co</a><br />
            Website: calldonna.co
          </p>
        </div>
      </div>
    </section>
  );
}
