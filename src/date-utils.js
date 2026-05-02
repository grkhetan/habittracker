function todayString() {
  return new Date().toISOString().slice(0, 10);
}

function parseDateInput(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) {
    return todayString();
  }
  return value;
}

function dateForDb(value) {
  return new Date(`${parseDateInput(value)}T00:00:00.000Z`);
}

function shiftDate(value, days) {
  const date = dateForDb(value);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function formatLongDate(value) {
  return dateForDb(value).toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC'
  });
}

module.exports = {
  dateForDb,
  formatLongDate,
  parseDateInput,
  shiftDate,
  todayString
};
