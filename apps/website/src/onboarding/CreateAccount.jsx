import { useState, useCallback } from 'react';
import { useSignUp, useSignIn } from '@clerk/clerk-react';

export default function CreateAccount({ data, update, onNext, devMode }) {
  const { signUp, isLoaded: signUpLoaded, setActive } = useSignUp();
  const { signIn, isLoaded: signInLoaded } = useSignIn();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [code, setCode] = useState('');
  const [mode, setMode] = useState('signup'); // 'signup' or 'signin'

  const handleEmailSignUp = async (e) => {
    e.preventDefault();
    if (devMode) {
      onNext();
      return;
    }
    if (!signUpLoaded) return;
    setError('');
    setLoading(true);

    try {
      const result = await signUp.create({
        emailAddress: data.email,
        password: data.password,
      });

      // If sign-up was created successfully, prepare verification
      if (result.status === 'complete') {
        // Account created without needing verification (unlikely but handle it)
        await setActive({ session: result.createdSessionId });
        update({ email: data.email, password: '' });
        onNext();
        return;
      }

      await signUp.prepareEmailAddressVerification({ strategy: 'email_code' });
      update({ password: '' });
      setVerifying(true);
    } catch (err) {
      const clerkError = err.errors?.[0];
      const errCode = clerkError?.code;
      const msg = clerkError?.longMessage || err.message || 'Failed to create account.';

      if (errCode === 'form_identifier_exists') {
        setError('An account with this email already exists. Please use a different email.');
      } else {
        setError(msg);
      }
    } finally {
      setLoading(false);
    }
  };

  const handleVerify = async (e) => {
    e.preventDefault();
    if (!signUpLoaded) return;
    setError('');
    setLoading(true);

    try {
      const result = await signUp.attemptEmailAddressVerification({ code });
      if (result.status === 'complete') {
        await setActive({ session: result.createdSessionId });
        update({ email: result.emailAddress || data.email, password: '' });
        onNext();
      } else {
        setError('Verification incomplete. Please try again.');
      }
    } catch (err) {
      setError(err.errors?.[0]?.longMessage || err.message || 'Invalid verification code.');
    } finally {
      setLoading(false);
    }
  };

  const handleComingSoon = useCallback((provider) => {
    setError(`${provider} sign-in will be available soon. Please use email and password for now.`);
  }, []);

  const handleSignIn = async (e) => {
    e.preventDefault();
    if (!signInLoaded) return;
    setError('');
    setLoading(true);
    try {
      const result = await signIn.create({
        identifier: data.email,
        password: data.password,
      });
      if (result.status === 'complete') {
        await setActive({ session: result.createdSessionId });
        update({ password: '' });
        // Existing user — go straight to dashboard
        window.location.href = '/dashboard';
      } else {
        setError('Sign in incomplete. Please try again.');
      }
    } catch (err) {
      const msg = err.errors?.[0]?.longMessage || err.message || 'Invalid email or password.';
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  if (mode === 'signin') {
    return (
      <div className="ob-create-account">
        <h1 className="ob-step-title">Sign in</h1>
        <p className="ob-step-subtitle">
          Welcome back! Sign in to access your dashboard.
        </p>
        <form onSubmit={handleSignIn}>
          <div className="ob-form-group">
            <label className="ob-label">Email</label>
            <input
              className="ob-input"
              type="email"
              value={data.email}
              onChange={(e) => update({ email: e.target.value })}
              placeholder="you@email.com"
              required
              autoFocus
            />
          </div>
          <div className="ob-form-group">
            <label className="ob-label">Password</label>
            <input
              className="ob-input"
              type="password"
              value={data.password}
              onChange={(e) => update({ password: e.target.value })}
              placeholder="Your password"
              required
            />
          </div>
          {error && <p className="ob-error">{error}</p>}
          <button
            type="submit"
            className="ob-footer__btn"
            disabled={loading || !data.email || !data.password}
            style={{ marginTop: 8 }}
          >
            {loading ? 'Signing in...' : 'Sign In'}
          </button>
        </form>
        <button
          type="button"
          className="ob-link-btn"
          onClick={() => { setMode('signup'); setError(''); }}
          style={{ marginTop: 16 }}
        >
          Don&apos;t have an account? Create one
        </button>
      </div>
    );
  }

  if (verifying) {
    return (
      <div className="ob-create-account">
        <h1 className="ob-step-title">Check your email</h1>
        <p className="ob-step-subtitle">
          We sent a verification code to {data.email}
        </p>
        <form onSubmit={handleVerify}>
          <div className="ob-form-group">
            <label className="ob-label">Verification code</label>
            <input
              className="ob-input"
              type="text"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="Enter 6-digit code"
              autoFocus
            />
          </div>
          {error && <p className="ob-error">{error}</p>}
          <button
            type="submit"
            className="ob-footer__btn"
            disabled={loading || !code}
            style={{ marginTop: 16 }}
          >
            {loading ? 'Verifying...' : 'Verify Email'}
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className="ob-create-account">
      <h1 className="ob-step-title">Create your account</h1>
      <p className="ob-step-subtitle">
        Set up Donna for your loved one in just a few minutes.
      </p>

      <div className="ob-social-btns">
        <button
          className="ob-social-btn ob-social-btn--apple"
          onClick={() => handleComingSoon('Apple')}
          type="button"
          style={{ opacity: 0.5, cursor: 'default' }}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
            <path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.8-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z" />
          </svg>
          Continue with Apple
          <span style={{ fontSize: '0.7rem', opacity: 0.7, marginLeft: 4 }}>Coming soon</span>
        </button>
        <button
          className="ob-social-btn"
          onClick={() => handleComingSoon('Google')}
          type="button"
          style={{ opacity: 0.5, cursor: 'default' }}
        >
          <svg width="20" height="20" viewBox="0 0 24 24">
            <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4" />
            <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
            <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05" />
            <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
          </svg>
          Continue with Google
          <span style={{ fontSize: '0.7rem', opacity: 0.7, marginLeft: 4 }}>Coming soon</span>
        </button>
      </div>

      <div className="ob-divider">or</div>

      <form onSubmit={handleEmailSignUp}>
        <div className="ob-form-group">
          <label className="ob-label">Email</label>
          <input
            className="ob-input"
            type="email"
            value={data.email}
            onChange={(e) => update({ email: e.target.value })}
            placeholder="you@email.com"
            required
          />
        </div>
        <div className="ob-form-group">
          <label className="ob-label">Password</label>
          <input
            className="ob-input"
            type="password"
            value={data.password}
            onChange={(e) => update({ password: e.target.value })}
            placeholder="Create a password"
            required
            minLength={8}
          />
        </div>
        {error && <p className="ob-error">{error}</p>}
        <button
          type="submit"
          className="ob-footer__btn"
          disabled={loading || !data.email || !data.password}
          style={{ marginTop: 8 }}
        >
          {loading ? 'Creating account...' : 'Create Account'}
        </button>
      </form>
      <button
        type="button"
        className="ob-link-btn"
        onClick={() => { setMode('signin'); setError(''); }}
        style={{ marginTop: 16 }}
      >
        Already have an account? Sign in
      </button>
    </div>
  );
}
