import { createContext, useContext, useReducer, useEffect, useCallback } from 'react';

const STORAGE_KEY = 'donna_onboarding';
const EXIT_FLAG_KEY = 'donna_onboarding_exited';

const initialState = {
  step: 0, // 0=create account, 1-7=steps, 8=success
  // Account
  email: '',
  password: '',
  // Step 1: About You
  firstName: '',
  lastName: '',
  phone: '',
  phoneCountryCode: '+1',
  // Step 2: Loved One
  lovedOneName: '',
  lovedOnePhone: '',
  lovedOneCountryCode: '+1',
  relationship: '',
  // Step 3: Location
  usBased: true,
  city: '',
  state: '',
  zipcode: '',
  country: '',
  // Step 4: Language
  language: 'english',
  // Step 5: Reminders
  reminders: [],
  // Step 6: Interests
  interests: {},
  additionalTopics: '',
  topicsToAvoid: '',
  // Step 7: Schedule
  calls: [],
};

function reducer(state, action) {
  switch (action.type) {
    case 'UPDATE':
      return { ...state, ...action.payload };
    case 'SET_STEP':
      return { ...state, step: action.payload };
    case 'RESET':
      return { ...initialState };
    case 'LOAD':
      return { ...initialState, ...action.payload };
    default:
      return state;
  }
}

const OnboardingContext = createContext(null);

function clearLegacyOnboardingStorage() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Ignore unavailable storage.
  }
}

export function OnboardingProvider({ children }) {
  const [state, dispatch] = useReducer(reducer, initialState, () => {
    if (typeof window === 'undefined') return initialState;
    try {
      // If the user explicitly exited, start fresh at step 0
      if (sessionStorage.getItem(EXIT_FLAG_KEY)) {
        sessionStorage.removeItem(EXIT_FLAG_KEY);
        clearLegacyOnboardingStorage();
        return initialState;
      }
      clearLegacyOnboardingStorage();
    } catch {
      // Ignore unavailable session storage and start fresh.
    }
    return initialState;
  });

  // Do not persist onboarding drafts. They can include credentials, phone
  // numbers, reminders, and family context, so state stays in memory only.
  useEffect(() => {
    clearLegacyOnboardingStorage();
  }, [state.step]);

  const update = useCallback((payload) => {
    dispatch({ type: 'UPDATE', payload });
  }, []);

  const setStep = useCallback((step) => {
    dispatch({ type: 'SET_STEP', payload: step });
  }, []);

  const reset = useCallback(() => {
    dispatch({ type: 'RESET' });
    try {
      clearLegacyOnboardingStorage();
      sessionStorage.setItem(EXIT_FLAG_KEY, 'true');
    } catch {
      // Ignore unavailable storage during reset.
    }
  }, []);

  return (
    <OnboardingContext.Provider value={{ data: state, update, setStep, reset }}>
      {children}
    </OnboardingContext.Provider>
  );
}

export function useOnboarding() {
  const ctx = useContext(OnboardingContext);
  if (!ctx) throw new Error('useOnboarding must be used within OnboardingProvider');
  return ctx;
}
