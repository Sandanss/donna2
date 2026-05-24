import { useState, useEffect, useMemo, useRef } from 'react';
import { useDashboard } from './DashboardContext';
import BackButton from './components/BackButton';
import { FlagImg } from '../onboarding/PhoneInput';
import { CheckIcon } from '../onboarding/icons';

/* ===== Constants ===== */

const INTERESTS = [
  { id: 'sports', label: 'Sports', question: 'Which teams or players do they follow?', placeholder: 'e.g., Detroit Lions, 1980s Celtics, Serena Williams' },
  { id: 'history', label: 'History', question: 'Which eras or events interest them most?', placeholder: 'e.g., World War II, Ancient Rome, Civil Rights Movement' },
  { id: 'music', label: 'Music', question: 'What genres or artists do they enjoy?', placeholder: 'e.g., Frank Sinatra, jazz, classical piano' },
  { id: 'film', label: 'Film', question: 'What genres or movies do they enjoy?', placeholder: 'e.g., old westerns, Audrey Hepburn films, comedies' },
  { id: 'politics', label: 'Politics', question: 'What topics or figures interest them?', placeholder: 'e.g., local politics, presidential history' },
  { id: 'poetry', label: 'Poetry', question: 'Any favorite poets or styles?', placeholder: 'e.g., Robert Frost, haiku, Shakespeare sonnets' },
  { id: 'geography', label: 'Geography', question: 'Any favorite places or regions?', placeholder: 'e.g., the Mediterranean, national parks, Japan' },
  { id: 'animals', label: 'Animals', question: 'Do they have pets or favorite animals?', placeholder: 'e.g., golden retriever named Max, loves birds' },
  { id: 'literature', label: 'Literature', question: 'What genres or authors do they enjoy?', placeholder: 'e.g., mystery novels, Agatha Christie, biographies' },
  { id: 'gardening', label: 'Gardening', question: 'What plants or gardening activities do they enjoy?', placeholder: 'e.g., roses, vegetable garden, orchids' },
  { id: 'travel', label: 'Travel', question: 'Where have they traveled or want to go?', placeholder: 'e.g., visited Italy in 1985, dreams of Alaska' },
  { id: 'cooking', label: 'Cooking', question: 'What cuisines or dishes do they enjoy?', placeholder: 'e.g., Italian recipes, baking bread, Southern comfort food' },
];

const US_STATES_LIST = [
  { abbr: 'AL', name: 'Alabama' }, { abbr: 'AK', name: 'Alaska' }, { abbr: 'AZ', name: 'Arizona' },
  { abbr: 'AR', name: 'Arkansas' }, { abbr: 'CA', name: 'California' }, { abbr: 'CO', name: 'Colorado' },
  { abbr: 'CT', name: 'Connecticut' }, { abbr: 'DE', name: 'Delaware' }, { abbr: 'DC', name: 'District of Columbia' },
  { abbr: 'FL', name: 'Florida' }, { abbr: 'GA', name: 'Georgia' }, { abbr: 'HI', name: 'Hawaii' },
  { abbr: 'ID', name: 'Idaho' }, { abbr: 'IL', name: 'Illinois' }, { abbr: 'IN', name: 'Indiana' },
  { abbr: 'IA', name: 'Iowa' }, { abbr: 'KS', name: 'Kansas' }, { abbr: 'KY', name: 'Kentucky' },
  { abbr: 'LA', name: 'Louisiana' }, { abbr: 'ME', name: 'Maine' }, { abbr: 'MD', name: 'Maryland' },
  { abbr: 'MA', name: 'Massachusetts' }, { abbr: 'MI', name: 'Michigan' }, { abbr: 'MN', name: 'Minnesota' },
  { abbr: 'MS', name: 'Mississippi' }, { abbr: 'MO', name: 'Missouri' }, { abbr: 'MT', name: 'Montana' },
  { abbr: 'NE', name: 'Nebraska' }, { abbr: 'NV', name: 'Nevada' }, { abbr: 'NH', name: 'New Hampshire' },
  { abbr: 'NJ', name: 'New Jersey' }, { abbr: 'NM', name: 'New Mexico' }, { abbr: 'NY', name: 'New York' },
  { abbr: 'NC', name: 'North Carolina' }, { abbr: 'ND', name: 'North Dakota' }, { abbr: 'OH', name: 'Ohio' },
  { abbr: 'OK', name: 'Oklahoma' }, { abbr: 'OR', name: 'Oregon' }, { abbr: 'PA', name: 'Pennsylvania' },
  { abbr: 'RI', name: 'Rhode Island' }, { abbr: 'SC', name: 'South Carolina' }, { abbr: 'SD', name: 'South Dakota' },
  { abbr: 'TN', name: 'Tennessee' }, { abbr: 'TX', name: 'Texas' }, { abbr: 'UT', name: 'Utah' },
  { abbr: 'VT', name: 'Vermont' }, { abbr: 'VA', name: 'Virginia' }, { abbr: 'WA', name: 'Washington' },
  { abbr: 'WV', name: 'West Virginia' }, { abbr: 'WI', name: 'Wisconsin' }, { abbr: 'WY', name: 'Wyoming' },
];

const TIMEZONES = [
  { value: 'America/New_York', label: 'Eastern (ET)' },
  { value: 'America/Chicago', label: 'Central (CT)' },
  { value: 'America/Denver', label: 'Mountain (MT)' },
  { value: 'America/Los_Angeles', label: 'Pacific (PT)' },
  { value: 'America/Anchorage', label: 'Alaska (AKT)' },
  { value: 'Pacific/Honolulu', label: 'Hawaii (HT)' },
  { value: 'America/Argentina/Buenos_Aires', label: 'Argentina (ART)' },
  { value: 'America/Mexico_City', label: 'Mexico City (CST)' },
  { value: 'America/Bogota', label: 'Colombia (COT)' },
  { value: 'America/Santiago', label: 'Chile (CLT)' },
  { value: 'America/Sao_Paulo', label: 'Brazil (BRT)' },
  { value: 'Europe/London', label: 'London (GMT/BST)' },
  { value: 'Europe/Madrid', label: 'Spain (CET)' },
];

/* ===== Interest Icon (inline, same as onboarding) ===== */
function InterestIcon({ id, size = 28, color = 'currentColor' }) {
  const s = { width: size, height: size, strokeWidth: 1.5, stroke: color, fill: 'none', strokeLinecap: 'round', strokeLinejoin: 'round' };
  switch (id) {
    case 'sports': return <svg viewBox="0 0 24 24" {...s}><path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6" /><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18" /><path d="M4 22h16" /><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22" /><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22" /><path d="M18 2H6v7a6 6 0 0 0 12 0V2Z" /></svg>;
    case 'history': return <svg viewBox="0 0 24 24" {...s}><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></svg>;
    case 'music': return <svg viewBox="0 0 24 24" {...s}><path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" /></svg>;
    case 'film': return <svg viewBox="0 0 24 24" {...s}><rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18" /><line x1="7" y1="2" x2="7" y2="22" /><line x1="17" y1="2" x2="17" y2="22" /><line x1="2" y1="12" x2="22" y2="12" /><line x1="2" y1="7" x2="7" y2="7" /><line x1="2" y1="17" x2="7" y2="17" /><line x1="17" y1="17" x2="22" y2="17" /><line x1="17" y1="7" x2="22" y2="7" /></svg>;
    case 'politics': return <svg viewBox="0 0 24 24" {...s}><line x1="3" y1="22" x2="21" y2="22" /><line x1="6" y1="18" x2="6" y2="11" /><line x1="10" y1="18" x2="10" y2="11" /><line x1="14" y1="18" x2="14" y2="11" /><line x1="18" y1="18" x2="18" y2="11" /><polygon points="12 2 20 7 4 7" /></svg>;
    case 'poetry': return <svg viewBox="0 0 24 24" {...s}><path d="M20.24 12.24a6 6 0 0 0-8.49-8.49L5 10.5V19h8.5z" /><line x1="16" y1="8" x2="2" y2="22" /><line x1="17.5" y1="15" x2="9" y2="15" /></svg>;
    case 'geography': return <svg viewBox="0 0 24 24" {...s}><circle cx="12" cy="12" r="10" /><line x1="2" y1="12" x2="22" y2="12" /><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" /></svg>;
    case 'animals': return <svg viewBox="0 0 24 24" {...s}><circle cx="11" cy="4" r="2" /><circle cx="18" cy="8" r="2" /><circle cx="20" cy="16" r="2" /><path d="M9 10a5 5 0 0 1 5 5v3.5a3.5 3.5 0 0 1-6.84 1.045Q6.52 17.48 4.46 16.84A3.5 3.5 0 0 1 5.5 10Z" /></svg>;
    case 'literature': return <svg viewBox="0 0 24 24" {...s}><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" /><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" /></svg>;
    case 'gardening': return <svg viewBox="0 0 24 24" {...s}><path d="M11 20A7 7 0 0 1 9.8 6.9C15.5 4.9 17 3.5 17 3.5s1.5 2.5-.5 6.5c-1.1 2.2-2.6 3.8-4.2 4.8" /><path d="M11.2 12.7c-1.6-1-3.1-2.6-4.2-4.8C5 3.9 6.5 1.4 6.5 1.4S8 2.8 13.7 4.8" /><path d="M12 20v-8" /></svg>;
    case 'travel': return <svg viewBox="0 0 24 24" {...s}><path d="M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z" /></svg>;
    case 'cooking': return <svg viewBox="0 0 24 24" {...s}><path d="M6 13.87A4 4 0 0 1 7.41 6a5.11 5.11 0 0 1 1.05-1.54 5 5 0 0 1 7.08 0A5.11 5.11 0 0 1 16.59 6 4 4 0 0 1 18 13.87V21H6Z" /><line x1="6" y1="17" x2="18" y2="17" /></svg>;
    default: return null;
  }
}

/* ===== Component ===== */

export default function LovedOneSettings() {
  const { senior, setSenior, loading: ctxLoading, error: ctxError, reload, api } = useDashboard();

  // Basic info
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');

  // Location
  const [usBased, setUsBased] = useState(true);
  const [city, setCity] = useState('');
  const [state, setState] = useState('');
  const [zipcode, setZipcode] = useState('');
  const [country, setCountry] = useState('');

  // City autocomplete
  const [cityQuery, setCityQuery] = useState('');
  const [showCityResults, setShowCityResults] = useState(false);
  const [allCities, setAllCities] = useState(null);
  const citiesLoadedRef = useRef(false);

  // Timezone
  const [timezone, setTimezone] = useState('');

  // Interests
  const [interests, setInterests] = useState([]);
  const [interestDetails, setInterestDetails] = useState({});
  const [expandedInterest, setExpandedInterest] = useState(null);
  const [draftDetail, setDraftDetail] = useState('');

  // Additional info
  const [additionalInfo, setAdditionalInfo] = useState('');
  const [topicsToAvoid, setTopicsToAvoid] = useState('');

  // Language
  const [donnaLanguage, setDonnaLanguage] = useState('en');

  // Save state
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  // Load city dataset lazily
  useEffect(() => {
    if (citiesLoadedRef.current) return;
    citiesLoadedRef.current = true;
    import('../onboarding/us-cities.js').then((mod) => {
      setAllCities(mod.US_CITIES);
    });
  }, []);

  // Hydrate from senior
  useEffect(() => {
    if (!senior) return;
    setName(senior.name || senior.seniorName || '');
    setPhone(senior.phone || senior.seniorPhone || '');
    setCity(senior.city || '');
    setState(senior.state || '');
    setZipcode(senior.zipcode || '');
    setCountry(senior.country || '');
    setCityQuery(senior.city || '');
    setTimezone(senior.timezone || '');

    // Determine US-based from existing data
    const hasCountry = !!senior.country && senior.country.toLowerCase() !== 'us' && senior.country.toLowerCase() !== 'usa' && senior.country.toLowerCase() !== 'united states';
    setUsBased(!hasCountry);

    // Interests: stored as array of IDs on senior.interests + details in familyInfo.interestDetails
    const seniorInterests = senior.interests || [];
    setInterests(seniorInterests);
    setInterestDetails(senior.familyInfo?.interestDetails || {});

    setAdditionalInfo(senior.additionalInfo || senior.familyInfo?.additionalInfo || '');
    setTopicsToAvoid(senior.familyInfo?.topicsToAvoid || '');
    setDonnaLanguage(senior.familyInfo?.donnaLanguage || 'en');
  }, [senior]);

  // City autocomplete results
  const cityResults = useMemo(() => {
    if (!usBased || !cityQuery || cityQuery.length < 2 || !allCities) return [];
    const q = cityQuery.toLowerCase().trim();
    const startsWithCity = [];
    const containsMatch = [];
    const zipMatch = [];
    for (const c of allCities) {
      const cityLower = c.city.toLowerCase();
      if (cityLower.startsWith(q)) startsWithCity.push(c);
      else if (cityLower.includes(q)) containsMatch.push(c);
      else if (c.zip && c.zip.startsWith(q)) zipMatch.push(c);
    }
    return [...startsWithCity, ...zipMatch, ...containsMatch].slice(0, 8);
  }, [cityQuery, allCities, usBased]);

  const selectCity = (c) => {
    setCity(c.city);
    setState(c.state);
    setZipcode(c.zip || zipcode);
    setCityQuery(c.city);
    setShowCityResults(false);
  };

  const toggleUsBased = (val) => {
    setUsBased(val);
    setCity('');
    setState('');
    setZipcode('');
    setCountry(val ? '' : country);
    setCityQuery('');
  };

  // Interest handlers
  const toggleInterest = (id) => {
    if (interests.includes(id)) {
      // Clicking a selected tile opens it for editing
      const interest = INTERESTS.find((i) => i.id === id);
      setExpandedInterest(interest);
      setDraftDetail(interestDetails[id] || '');
    } else {
      const interest = INTERESTS.find((i) => i.id === id);
      setExpandedInterest(interest);
      setDraftDetail(interestDetails[id] || '');
    }
  };

  const removeInterest = (id) => {
    setInterests(interests.filter((i) => i !== id));
    const updated = { ...interestDetails };
    delete updated[id];
    setInterestDetails(updated);
    if (expandedInterest?.id === id) {
      setExpandedInterest(null);
      setDraftDetail('');
    }
  };

  const handleInterestDone = () => {
    if (!expandedInterest) return;
    setInterests((prev) => prev.includes(expandedInterest.id) ? prev : [...prev, expandedInterest.id]);
    setInterestDetails((prev) => ({ ...prev, [expandedInterest.id]: draftDetail }));
    setExpandedInterest(null);
    setDraftDetail('');
  };

  const handleInterestClose = () => {
    setExpandedInterest(null);
    setDraftDetail('');
  };

  // Save
  const handleSave = async () => {
    if (!senior) return;
    setSaving(true);
    setSaved(false);
    try {
      const payload = {
        name,
        phone,
        city,
        state: usBased ? state : '',
        zipcode: usBased ? zipcode : '',
        country: usBased ? '' : country,
        timezone,
        interests,
        additionalInfo,
        familyInfo: {
          ...senior.familyInfo,
          interestDetails,
          topicsToAvoid,
          donnaLanguage,
          additionalInfo,
        },
      };
      await api.updateSenior(senior.id, payload);
      setSenior((prev) => ({
        ...prev,
        ...payload,
        familyInfo: payload.familyInfo,
      }));
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      alert('Failed to save: ' + err.message);
    } finally {
      setSaving(false);
    }
  };

  if (ctxLoading) {
    return <div className="db-loading"><div className="db-spinner" /></div>;
  }

  if (ctxError) {
    return (
      <div className="db-error">
        <p className="db-error__text">Something went wrong: {ctxError}</p>
        <button className="db-btn db-btn--primary" onClick={reload}>Try Again</button>
      </div>
    );
  }

  if (!senior) {
    return (
      <div className="db-empty">
        <p className="db-empty__text">No loved one found. Complete onboarding to get started.</p>
        <a className="db-btn db-btn--primary" href="/signup">Start Onboarding</a>
      </div>
    );
  }

  const selectedInterests = INTERESTS.filter((i) => interests.includes(i.id));
  const unselectedInterests = INTERESTS.filter((i) => !interests.includes(i.id));

  return (
    <div>
      <BackButton />
      <div className="db-page__header">
        <h1 className="db-page__title">{senior?.name || 'Loved One'}&apos;s Profile</h1>
      </div>

      {/* Basic Info */}
      <div className="db-card" style={{ padding: 24, marginBottom: 20 }}>
        <div className="db-section__title">Basic Information</div>
        <div className="db-field">
          <label className="db-label">Name</label>
          <input className="db-input" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="db-field">
          <label className="db-label">Phone</label>
          <input className="db-input" value={phone} onChange={(e) => setPhone(e.target.value)} />
        </div>
      </div>

      {/* Location */}
      <div className="db-card" style={{ padding: 24, marginBottom: 20 }}>
        <div className="db-section__title">Location</div>
        <p style={{ fontSize: 13, color: 'var(--fg-2)', marginBottom: 16, marginTop: -8 }}>
          Helps ensure calls are in the right time zone and Donna can discuss local weather and news.
        </p>

        {/* US/International toggle */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
          <span style={{ fontSize: '0.9rem', fontWeight: 500, color: 'var(--fg-1)' }}>U.S. Based</span>
          <button
            type="button"
            className={`db-toggle__switch ${usBased ? 'db-toggle__switch--on' : ''}`}
            onClick={() => toggleUsBased(!usBased)}
          />
          <span style={{ fontSize: '0.85rem', color: 'var(--fg-2)' }}>{usBased ? 'Yes' : 'No'}</span>
        </div>

        {usBased ? (
          <>
            <div className="db-field" style={{ position: 'relative' }}>
              <label className="db-label">City</label>
              <input
                className="db-input"
                value={cityQuery}
                onChange={(e) => {
                  setCityQuery(e.target.value);
                  setCity(e.target.value);
                  setShowCityResults(true);
                }}
                onFocus={() => setShowCityResults(true)}
                onBlur={() => setTimeout(() => setShowCityResults(false), 200)}
                placeholder="Search for a city or zip code..."
              />
              {showCityResults && cityResults.length > 0 && (
                <div className="ob-city-results" style={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 10 }}>
                  {cityResults.map((c, i) => (
                    <button
                      key={`${c.city}-${c.state}-${i}`}
                      className="ob-city-result"
                      type="button"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => selectCity(c)}
                    >
                      <span>{c.city}, {c.state}</span>
                      {c.zip && <span className="ob-city-result__zip">{c.zip}</span>}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
              <div className="db-field">
                <label className="db-label">State</label>
                <select
                  className="db-input"
                  value={state}
                  onChange={(e) => setState(e.target.value)}
                  style={{ appearance: 'none', backgroundImage: "url(\"data:image/svg+xml,%3Csvg width='12' height='8' viewBox='0 0 12 8' fill='none' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M1 1.5L6 6.5L11 1.5' stroke='%23888' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E\")", backgroundRepeat: 'no-repeat', backgroundPosition: 'right 16px center', paddingRight: 40 }}
                >
                  <option value="">Select state...</option>
                  {US_STATES_LIST.map((s) => (
                    <option key={s.abbr} value={s.abbr}>{s.name}</option>
                  ))}
                </select>
              </div>
              <div className="db-field">
                <label className="db-label">ZIP Code</label>
                <input
                  className="db-input"
                  value={zipcode}
                  onChange={(e) => setZipcode(e.target.value)}
                  placeholder="Enter zip code"
                  maxLength={5}
                  inputMode="numeric"
                />
              </div>
            </div>
          </>
        ) : (
          <>
            <div className="db-field">
              <label className="db-label">City</label>
              <input
                className="db-input"
                value={city}
                onChange={(e) => setCity(e.target.value)}
                placeholder="Enter city"
              />
            </div>
            <div className="db-field">
              <label className="db-label">Country</label>
              <input
                className="db-input"
                value={country}
                onChange={(e) => setCountry(e.target.value)}
                placeholder="Enter country"
              />
            </div>
          </>
        )}

        <div className="db-field" style={{ marginBottom: 0 }}>
          <label className="db-label">Timezone</label>
          <select
            className="db-input"
            value={timezone}
            onChange={(e) => setTimezone(e.target.value)}
            style={{ appearance: 'none', backgroundImage: "url(\"data:image/svg+xml,%3Csvg width='12' height='8' viewBox='0 0 12 8' fill='none' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M1 1.5L6 6.5L11 1.5' stroke='%23888' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E\")", backgroundRepeat: 'no-repeat', backgroundPosition: 'right 16px center', paddingRight: 40 }}
          >
            <option value="">Select timezone...</option>
            {TIMEZONES.map((tz) => (
              <option key={tz.value} value={tz.value}>{tz.label}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Interests */}
      <div className="db-card" style={{ padding: 24, marginBottom: 20 }}>
        <div className="db-section__title">Interests</div>
        <p style={{ fontSize: 13, color: 'var(--fg-2)', marginBottom: 16, marginTop: -8 }}>
          Select interests that Donna can use to spark engaging conversations.
        </p>

        {/* Expanded interest card */}
        {expandedInterest && (
          <div className="ob-interest-expanded" style={{ marginBottom: 16 }}>
            <div className="ob-interest-expanded__header">
              <InterestIcon id={expandedInterest.id} size={24} color="white" />
              <span className="ob-interest-expanded__title">{expandedInterest.label}</span>
              <button type="button" className="ob-interest-expanded__close" onClick={handleInterestClose}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round">
                  <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
            <p className="ob-interest-expanded__question">{expandedInterest.question}</p>
            <input
              type="text"
              className="ob-interest-expanded__input"
              value={draftDetail}
              onChange={(e) => setDraftDetail(e.target.value)}
              placeholder={expandedInterest.placeholder}
              autoFocus
            />
            <button type="button" className="ob-interest-expanded__done" onClick={handleInterestDone}>
              Done
            </button>
          </div>
        )}

        {/* Selected interests */}
        {selectedInterests.length > 0 && (
          <div className="ob-interest-grid" style={{ marginBottom: 12 }}>
            {selectedInterests.map((interest) => (
              <div
                key={interest.id}
                className="ob-interest-tile ob-interest-tile--selected"
                onClick={() => toggleInterest(interest.id)}
                style={{ cursor: 'pointer' }}
              >
                <button
                  type="button"
                  className="ob-interest-tile__remove"
                  onClick={(e) => { e.stopPropagation(); removeInterest(interest.id); }}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round">
                    <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
                <div className="ob-interest-tile__icon">
                  <InterestIcon id={interest.id} size={28} color="white" />
                </div>
                <div className="ob-interest-tile__name">{interest.label}</div>
              </div>
            ))}
          </div>
        )}

        {/* Unselected interests */}
        {unselectedInterests.length > 0 && (
          <div className={`ob-interest-grid${selectedInterests.length > 0 ? ' ob-interest-grid--gap' : ''}`}>
            {unselectedInterests.map((interest) => (
              <button
                key={interest.id}
                type="button"
                className="ob-interest-tile"
                onClick={() => toggleInterest(interest.id)}
              >
                <div className="ob-interest-tile__icon">
                  <InterestIcon id={interest.id} size={28} color="#666" />
                </div>
                <div className="ob-interest-tile__name">{interest.label}</div>
              </button>
            ))}
          </div>
        )}

        <div className="db-field" style={{ marginTop: 20 }}>
          <label className="db-label">Additional topics or interests</label>
          <textarea
            className="db-input db-textarea"
            value={additionalInfo}
            onChange={(e) => setAdditionalInfo(e.target.value)}
            placeholder="e.g., She loves talking about her golden retriever, Max, and reminiscing about her years living in San Francisco."
            rows={3}
          />
        </div>

        <div className="db-field" style={{ marginBottom: 0 }}>
          <label className="db-label">Topics to avoid</label>
          <textarea
            className="db-input db-textarea"
            value={topicsToAvoid}
            onChange={(e) => setTopicsToAvoid(e.target.value)}
            placeholder="Anything Donna should steer clear of..."
            rows={2}
          />
        </div>
      </div>

      {/* Donna Language */}
      <div className="db-card" style={{ padding: 24, marginBottom: 20 }}>
        <div className="db-section__title">Donna&apos;s Language</div>
        <p style={{ fontSize: 13, color: 'var(--fg-2)', marginBottom: 16, marginTop: -8 }}>
          Choose the language Donna speaks during calls.
        </p>
        <div className="ob-radio-cards">
          <button
            type="button"
            className={`ob-radio-card${donnaLanguage === 'en' ? ' ob-radio-card--selected' : ''}`}
            onClick={() => setDonnaLanguage('en')}
          >
            <div className="ob-radio-card__icon" style={{ background: '#EEF2FF' }}>
              <FlagImg iso="us" size={40} circle />
            </div>
            <div className="ob-radio-card__text">
              <div className="ob-radio-card__title">English</div>
              <div className="ob-radio-card__desc">US English</div>
            </div>
            <div className="ob-radio-card__check">
              {donnaLanguage === 'en' && <CheckIcon size={14} />}
            </div>
          </button>
          <button
            type="button"
            className={`ob-radio-card${donnaLanguage === 'es' ? ' ob-radio-card--selected' : ''}`}
            onClick={() => setDonnaLanguage('es')}
          >
            <div className="ob-radio-card__icon" style={{ background: '#FEF3E2' }}>
              <FlagImg iso="mx" size={40} circle />
            </div>
            <div className="ob-radio-card__text">
              <div className="ob-radio-card__title">Spanish</div>
              <div className="ob-radio-card__desc">Espa&ntilde;ol</div>
            </div>
            <div className="ob-radio-card__check">
              {donnaLanguage === 'es' && <CheckIcon size={14} />}
            </div>
          </button>
        </div>
      </div>

      {/* Save */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <button
          className="db-btn db-btn--primary db-btn--wide"
          onClick={handleSave}
          disabled={saving}
        >
          {saving ? 'Saving...' : 'Save Changes'}
        </button>
      </div>
      {saved && (
        <div style={{ color: 'var(--color-success)', fontSize: 14, fontWeight: 600, marginTop: 12 }}>
          Saved!
        </div>
      )}
    </div>
  );
}
