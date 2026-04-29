import { ChevronLeftIcon } from './icons';

const TOTAL_STEPS = 7;

export default function OnboardingShell({
  step,
  onBack,
  onExit,
  onNext,
  nextLabel = 'Continue',
  nextDisabled = false,
  showSkip = false,
  onSkip,
  showFooter = true,
  children,
}) {
  const showHeader = step > 0 && step <= TOTAL_STEPS;
  const showProgress = step >= 1 && step <= TOTAL_STEPS;

  const handleBrandClick = () => {
    if (onExit) onExit();
  };

  return (
    <div className="onboarding">
      {showHeader && (
        <header className="ob-header">
          <div className="ob-header__inner">
            <button className="ob-header__back" onClick={onBack} aria-label="Go back">
              <ChevronLeftIcon size={24} />
            </button>
            <button className="ob-header__brand ob-header__brand--link" onClick={handleBrandClick} type="button">
              Donna
            </button>
            <span className="ob-header__step">
              Step {step} of {TOTAL_STEPS}
            </span>
          </div>
        </header>
      )}

      {showProgress && (
        <div className="ob-progress">
          {Array.from({ length: TOTAL_STEPS }, (_, i) => (
            <div
              key={i}
              className={`ob-progress__segment${
                i + 1 < step ? ' ob-progress__segment--completed' : ''
              }${i + 1 === step ? ' ob-progress__segment--active' : ''}`}
            />
          ))}
        </div>
      )}

      <div className="ob-content">{children}</div>

      {showFooter && (
        <footer className="ob-footer">
          <div className="ob-footer__inner">
            <button
              className="ob-footer__btn"
              onClick={onNext}
              disabled={nextDisabled}
            >
              {nextLabel}
            </button>
            {showSkip && (
              <button className="ob-footer__skip" onClick={onSkip}>
                Skip for now
              </button>
            )}
          </div>
        </footer>
      )}
    </div>
  );
}
