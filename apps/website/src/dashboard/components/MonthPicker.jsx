import { useState } from 'react';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_FULL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export default function MonthPicker({ currentDate, onSelectMonth }) {
  const [open, setOpen] = useState(false);
  const [viewYear, setViewYear] = useState(currentDate.getFullYear());
  const year = currentDate.getFullYear();
  const month = currentDate.getMonth();

  const handleOpen = () => {
    setViewYear(currentDate.getFullYear());
    setOpen(true);
  };

  const handleSelect = (monthIdx) => {
    const newDate = new Date(viewYear, monthIdx, 1);
    onSelectMonth(newDate);
    setOpen(false);
  };

  return (
    <>
      <button className="db-month-btn" onClick={handleOpen}>
        {MONTHS_FULL[month]} {year}
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {open && (
        <div className="db-month-overlay" onClick={() => setOpen(false)}>
          <div className="db-month-grid" onClick={(e) => e.stopPropagation()}>
            <div className="db-month-year-nav">
              <button
                className="db-month-year-nav__arrow"
                onClick={() => setViewYear((y) => y - 1)}
                aria-label="Previous year"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="15 18 9 12 15 6" />
                </svg>
              </button>
              <span className="db-month-year-nav__year">{viewYear}</span>
              <button
                className="db-month-year-nav__arrow"
                onClick={() => setViewYear((y) => y + 1)}
                aria-label="Next year"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="9 18 15 12 9 6" />
                </svg>
              </button>
            </div>
            {MONTHS.map((m, i) => (
              <button
                key={m}
                className={`db-month-grid__item ${i === month && viewYear === year ? 'db-month-grid__item--active' : ''}`}
                onClick={() => handleSelect(i)}
              >
                {m}
              </button>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
