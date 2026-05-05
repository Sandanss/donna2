import { useState, useCallback, useMemo, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useAuth } from '@clerk/clerk-react';
import { OnboardingProvider, useOnboarding } from './store.jsx';
import OnboardingShell from './OnboardingShell';
import CreateAccount from './CreateAccount';
import Step1_AboutYou from './Step1_AboutYou';
import Step2_LovedOne from './Step2_LovedOne';
import Step3_Location from './Step3_Location';
import Step4_Language from './Step4_Language';
import Step5_Reminders from './Step5_Reminders';
import Step6_Interests from './Step6_Interests';
import Step7_Schedule from './Step7_Schedule';
import Success from './Success';
import { submitOnboarding } from './api';
import './onboarding.css';

const MOCK_DATA = {
  email: 'jane@example.com',
  password: 'password123',
  firstName: 'Jane',
  lastName: 'Doe',
  phone: '(555) 123-4567',
  lovedOneName: 'Margaret',
  lovedOnePhone: '(555) 987-6543',
  relationship: 'Mother',
  city: 'New York',
  state: 'NY',
  zipcode: '10001',
  language: 'english',
  reminders: [{ title: 'Take morning medication', description: 'Blood pressure pills with breakfast' }],
  interests: {
    gardening: { selected: true, detail: 'Loves roses and tomatoes' },
    cooking: { selected: true, detail: 'Italian recipes' },
    reading: { selected: true, detail: 'Mystery novels' },
  },
  additionalTopics: 'Her grandchildren',
  topicsToAvoid: 'Politics',
  calls: [{ title: 'Daily Check-in', frequency: 'daily', days: [], time: '10:00', reminderIds: [0] }],
};

const stepVariants = {
  enter: { opacity: 0, x: 30 },
  center: { opacity: 1, x: 0 },
  exit: { opacity: 0, x: -30 },
};

function DevPanel({ step, setStep, reset, fillMock }) {
  return (
    <div className="ob-dev-panel">
      <div className="ob-dev-panel__title">
        ⚡ Dev Mode
      </div>
      <select value={step} onChange={(e) => setStep(Number(e.target.value))}>
        <option value={0}>Create Account</option>
        <option value={1}>Step 1: About You</option>
        <option value={2}>Step 2: Loved One</option>
        <option value={3}>Step 3: Location</option>
        <option value={4}>Step 4: Language</option>
        <option value={5}>Step 5: Reminders</option>
        <option value={6}>Step 6: Interests</option>
        <option value={7}>Step 7: Schedule</option>
        <option value={8}>Success</option>
      </select>
      <button onClick={fillMock} style={{ marginBottom: 4 }}>Fill mock data</button>
      <button onClick={reset}>Reset all data</button>
    </div>
  );
}

function OnboardingInner() {
  const { data, update, setStep, reset } = useOnboarding();
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Dev mode detection
  const devMode = useMemo(() => {
    if (typeof window === 'undefined') return false;
    return import.meta.env.DEV || window.location.search.includes('dev=true');
  }, []);

  // Try to get Clerk auth (may not be available in dev mode / SSR)
  let getToken = null;
  let isSignedIn = false;
  try {
    const auth = useAuth();
    getToken = auth.getToken;
    isSignedIn = !!auth.isSignedIn;
  } catch {
    // Clerk hooks are unavailable during static rendering and local dev fallbacks.
  }

  // If already signed in, skip create account; if they completed onboarding, go to dashboard
  // But don't skip if the user just explicitly exited — they should see step 0
  useEffect(() => {
    if (!isSignedIn || devMode) return;
    if (data.step === 0) {
      try {
        if (sessionStorage.getItem('donna_onboarding_exited')) {
          sessionStorage.removeItem('donna_onboarding_exited');
          return; // Stay on step 0
        }
      } catch {
        // sessionStorage unavailable — proceed normally
      }
      setStep(1);
    } else if (data.step === 8) {
      // Already completed onboarding — send them to dashboard
      window.location.href = '/dashboard';
    }
  }, [isSignedIn, data.step, devMode, setStep]);

  const step = data.step;

  const goNext = useCallback(() => {
    setStep(Math.min(step + 1, 8));
    window.scrollTo(0, 0);
  }, [step, setStep]);

  const handleExit = useCallback(() => {
    const confirmed = window.confirm(
      'Are you sure you want to leave? You\'ll lose all your progress in the signup flow.'
    );
    if (confirmed) {
      // Clear any legacy persisted onboarding payload before navigation.
      try {
        localStorage.removeItem('donna_onboarding');
        sessionStorage.setItem('donna_onboarding_exited', 'true');
      } catch {
        // Storage unavailable — reset() will still clear in-memory state
      }
      reset();
      window.location.href = '/';
    }
  }, [reset]);

  const goBack = useCallback(() => {
    if (step <= 1) {
      handleExit();
      return;
    }
    setStep(step - 1);
    window.scrollTo(0, 0);
  }, [step, setStep, handleExit]);

  const handleSubmit = useCallback(async () => {
    setError('');
    setSubmitting(true);
    try {
      let token = null;
      if (getToken && !devMode) {
        token = await getToken();
      }
      await submitOnboarding(data, token);
      setStep(8);
      window.scrollTo(0, 0);
      // Clear any legacy persisted onboarding payload on success.
      try {
        localStorage.removeItem('donna_onboarding');
      } catch {
        // Local storage can be unavailable in private browsing or SSR-like contexts.
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }, [data, getToken, devMode, setStep]);

  const fillMock = useCallback(() => {
    update(MOCK_DATA);
  }, [update]);

  // Determine what to show in the shell
  const isCreateAccount = step === 0;
  const isSuccess = step === 8;

  // Validation for continue button
  const canContinue = useMemo(() => {
    switch (step) {
      case 1: return data.firstName && data.lastName;
      case 2: return data.lovedOneName && data.lovedOnePhone && data.relationship;
      case 3: return data.usBased ? (data.city && data.state) : (data.city && data.country);
      case 4: return data.language;
      case 5: return true; // optional
      case 6: return true; // optional
      case 7: return (data.calls || []).length > 0;
      default: return true;
    }
  }, [step, data]);

  // Step 7: "Create profile" as the final submit
  const isLastStep = step === 7;

  const handleNext = useCallback(() => {
    if (isLastStep) {
      if (devMode) {
        setStep(8);
        window.scrollTo(0, 0);
        return;
      }
      handleSubmit();
    } else {
      goNext();
    }
  }, [isLastStep, devMode, handleSubmit, goNext, setStep]);

  const renderStep = () => {
    switch (step) {
      case 0:
        return <CreateAccount data={data} update={update} onNext={goNext} devMode={devMode} />;
      case 1:
        return <Step1_AboutYou data={data} update={update} />;
      case 2:
        return <Step2_LovedOne data={data} update={update} />;
      case 3:
        return <Step3_Location data={data} update={update} />;
      case 4:
        return <Step4_Language data={data} update={update} />;
      case 5:
        return <Step5_Reminders data={data} update={update} />;
      case 6:
        return <Step6_Interests data={data} update={update} />;
      case 7:
        return <Step7_Schedule data={data} update={update} />;
      case 8:
        return <Success data={data} />;
      default:
        return null;
    }
  };

  // Create Account and Success screens have their own layouts
  if (isCreateAccount) {
    return (
      <div className="onboarding">
        <header className="ob-header">
          <div className="ob-header__inner">
            <a href="/" className="ob-header__brand ob-header__brand--link" style={{ textDecoration: 'none' }}>
              Donna
            </a>
            <span />
            <span />
          </div>
        </header>
        <div className="ob-content">
          <AnimatePresence mode="wait">
            <motion.div
              key={step}
              variants={stepVariants}
              initial="enter"
              animate="center"
              exit="exit"
              transition={{ duration: 0.2 }}
            >
              {renderStep()}
            </motion.div>
          </AnimatePresence>
        </div>
        {devMode && <DevPanel step={step} setStep={setStep} reset={reset} fillMock={fillMock} />}
      </div>
    );
  }

  if (isSuccess) {
    return (
      <div className="onboarding">
        <div className="ob-content">
          {renderStep()}
        </div>
        {devMode && <DevPanel step={step} setStep={setStep} reset={reset} fillMock={fillMock} />}
      </div>
    );
  }

  return (
    <>
      <OnboardingShell
        step={step}
        onBack={goBack}
        onExit={handleExit}
        onNext={handleNext}
        nextLabel={isLastStep ? (submitting ? 'Creating profile...' : 'Create profile') : 'Continue'}
        nextDisabled={!canContinue || submitting}
        showSkip={step === 5 || step === 6}
        onSkip={goNext}
        showFooter={true}
      >
        {error && (
          <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, padding: '12px 16px', marginBottom: 16, color: '#dc2626', fontSize: '0.9rem' }}>
            {error}
          </div>
        )}
        <AnimatePresence mode="wait">
          <motion.div
            key={step}
            variants={stepVariants}
            initial="enter"
            animate="center"
            exit="exit"
            transition={{ duration: 0.2 }}
          >
            {renderStep()}
          </motion.div>
        </AnimatePresence>
      </OnboardingShell>
      {devMode && <DevPanel step={step} setStep={setStep} reset={reset} fillMock={fillMock} />}
    </>
  );
}

export default function OnboardingFlow() {
  return (
    <OnboardingProvider>
      <OnboardingInner />
    </OnboardingProvider>
  );
}
