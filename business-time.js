// Tiempo de negocio: la empresa opera en America/Asuncion (24 h), no en UTC.
// Las columnas `date` se guardan como fecha civil; acá solo se resuelve el día
// del negocio para comparar contra "hoy" y para mostrarlo en documentos
// públicos. Un instante de la tarde en Asunción no puede leerse como el día
// siguiente (UTC) ni al revés.
export const timeZone = 'America/Asuncion';

const dateFormatter = new Intl.DateTimeFormat('en-CA', {timeZone, year: 'numeric', month: '2-digit', day: '2-digit'});

/** Día de la empresa (YYYY-MM-DD) para un instante. */
export function zoneDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? dateFormatter.format(date) : null;
}

/** Día de la empresa de hoy; `now` solo se usa en pruebas. */
export function zoneToday(now = new Date()) {
  return zoneDate(now);
}

/**
 * Día civil (YYYY-MM-DD) de un valor de columna `date`, sin pasar por UTC.
 * Los drivers no coinciden: unos entregan el `date` como medianoche UTC
 * (PGlite) y otros como medianoche local (pg). Se detecta cuál es y se
 * recupera el día guardado en ambos casos.
 */
export function civilDate(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'string') {
    const match = /^(\d{4}-\d{2}-\d{2})/.exec(value);
    return match ? match[1] : null;
  }
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    const pad = number => String(number).padStart(2, '0');
    const localMidnight = value.getHours() === 0 && value.getMinutes() === 0 && value.getSeconds() === 0 && value.getMilliseconds() === 0;
    if (localMidnight) return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
    return value.toISOString().slice(0, 10);
  }
  return null;
}

/** Día de la empresa del lado SQL, para comparar columnas `date`. */
export const zoneTodaySql = `(now() at time zone '${timeZone}')::date`;
