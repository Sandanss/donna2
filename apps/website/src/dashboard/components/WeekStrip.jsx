const DAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAYS_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function getWeekDates(referenceDate) {
  const d = new Date(referenceDate);
  const day = d.getDay();
  const start = new Date(d);
  start.setDate(d.getDate() - day);
  const dates = [];
  for (let i = 0; i < 7; i++) {
    const date = new Date(start);
    date.setDate(start.getDate() + i);
    dates.push(date);
  }
  return dates;
}

export default function WeekStrip({ selectedDate, onSelectDate, scheduledDays, scheduledDates, onPrevWeek, onNextWeek }) {
  const weekDates = getWeekDates(selectedDate);

  return (
    <div className="db-week">
      <button className="db-week__nav" onClick={onPrevWeek} aria-label="Previous week">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="15 18 9 12 15 6" />
        </svg>
      </button>

      <div className="db-week__days">
        {weekDates.map((date, i) => {
          const dayName = DAYS_FULL[date.getDay()];
          const dateStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
          const isSelected = date.toDateString() === selectedDate.toDateString();
          const hasCall = scheduledDays.has(dayName) || scheduledDates?.has(dateStr);

          return (
            <button
              key={i}
              className={`db-week__day ${isSelected ? 'db-week__day--selected' : ''}`}
              onClick={() => onSelectDate(date)}
            >
              <span className="db-week__day-name">{DAYS_SHORT[date.getDay()]}</span>
              <span className="db-week__day-num">{date.getDate()}</span>
              {hasCall && <span className="db-week__dot" />}
            </button>
          );
        })}
      </div>

      <button className="db-week__nav" onClick={onNextWeek} aria-label="Next week">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="9 18 15 12 9 6" />
        </svg>
      </button>
    </div>
  );
}
