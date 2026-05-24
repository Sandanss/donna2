import { useState, useMemo, useEffect, useRef } from 'react';

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

export default function Step3_Location({ data, update }) {
  const [query, setQuery] = useState(data.city || '');
  const [showResults, setShowResults] = useState(false);
  const [allCities, setAllCities] = useState(null);
  const loadedRef = useRef(false);
  const usBased = data.usBased !== false;

  // Lazy-load the full city dataset on mount
  useEffect(() => {
    if (loadedRef.current) return;
    loadedRef.current = true;
    import('./us-cities.js').then((mod) => {
      setAllCities(mod.US_CITIES);
    });
  }, []);

  const results = useMemo(() => {
    if (!usBased || !query || query.length < 2 || !allCities) return [];
    const q = query.toLowerCase().trim();

    const startsWithCity = [];
    const containsMatch = [];
    const zipMatch = [];

    for (const c of allCities) {
      const cityLower = c.city.toLowerCase();
      if (cityLower.startsWith(q)) {
        startsWithCity.push(c);
      } else if (cityLower.includes(q)) {
        containsMatch.push(c);
      } else if (c.zip && c.zip.startsWith(q)) {
        zipMatch.push(c);
      }
    }

    return [...startsWithCity, ...zipMatch, ...containsMatch].slice(0, 8);
  }, [query, allCities, usBased]);

  const selectCity = (c) => {
    update({ city: c.city, state: c.state, zipcode: c.zip || data.zipcode || '' });
    setQuery(c.city);
    setShowResults(false);
  };

  const toggleUsBased = (val) => {
    update({
      usBased: val,
      city: '',
      state: '',
      zipcode: '',
      country: val ? '' : data.country,
    });
    setQuery('');
  };

  // International form
  if (!usBased) {
    return (
      <div>
        <h1 className="ob-step-title">About your <em className="ob-step-title__accent">loved one.</em></h1>
        <p className="ob-step-subtitle">
          Location: letting us know where your loved one lives helps ensure calls are delivered in the proper time zones and that Donna can answer related questions about things like the local weather and news.
        </p>

        <div className="ob-form-group">
          <label className="ob-label">City</label>
          <input
            className="ob-input"
            type="text"
            value={data.city}
            onChange={(e) => update({ city: e.target.value })}
            placeholder="Enter city"
          />
        </div>

        <div className="ob-form-group">
          <label className="ob-label">Country</label>
          <input
            className="ob-input"
            type="text"
            value={data.country}
            onChange={(e) => update({ country: e.target.value })}
            placeholder="Enter country"
          />
        </div>

        <div className="ob-toggle-row">
          <span className="ob-toggle-label">U.S. Based</span>
          <button
            type="button"
            className={`ob-toggle ${usBased ? 'ob-toggle--on' : ''}`}
            onClick={() => toggleUsBased(!usBased)}
          >
            <span className="ob-toggle__thumb" />
          </button>
          <span className="ob-toggle-value">{usBased ? 'Yes' : 'No'}</span>
        </div>
      </div>
    );
  }

  // US form
  return (
    <div>
      <h1 className="ob-step-title">About your <em className="ob-step-title__accent">loved one.</em></h1>
      <p className="ob-step-subtitle">
        Location: letting us know where your loved one lives helps ensure calls are delivered in the proper time zones and that Donna can answer related questions about things like the local weather and news.
      </p>

      <div className="ob-form-group ob-city-search">
        <label className="ob-label">City</label>
        <input
          className="ob-input"
          type="text"
          value={query}
          onChange={(e) => {
            const val = e.target.value;
            setQuery(val);
            setShowResults(true);
            update({ city: val });
          }}
          onFocus={() => setShowResults(true)}
          onBlur={() => setTimeout(() => setShowResults(false), 200)}
          placeholder="Search for a city or zip code..."
        />
        {showResults && results.length > 0 && (
          <div className="ob-city-results">
            {results.map((c, i) => (
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

      <div className="ob-form-group">
        <label className="ob-label">State</label>
        <select
          className="ob-select"
          value={data.state}
          onChange={(e) => update({ state: e.target.value })}
        >
          <option value="">Select state...</option>
          {US_STATES_LIST.map((s) => (
            <option key={s.abbr} value={s.abbr}>{s.name}</option>
          ))}
        </select>
      </div>

      <div className="ob-form-group">
        <label className="ob-label">Zip code</label>
        <input
          className="ob-input"
          type="text"
          value={data.zipcode}
          onChange={(e) => update({ zipcode: e.target.value })}
          placeholder="Enter zip code"
          maxLength={5}
          inputMode="numeric"
        />
      </div>

      <div className="ob-toggle-row">
        <span className="ob-toggle-label">U.S. Based</span>
        <button
          type="button"
          className={`ob-toggle ${usBased ? 'ob-toggle--on' : ''}`}
          onClick={() => toggleUsBased(!usBased)}
        >
          <span className="ob-toggle__thumb" />
        </button>
        <span className="ob-toggle-value">{usBased ? 'Yes' : 'No'}</span>
      </div>
    </div>
  );
}
