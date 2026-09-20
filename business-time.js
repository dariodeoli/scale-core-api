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

/** Día de la empresa del lado SQL, para comparar columnas `date`. */
export const zoneTodaySql = `(now() at time zone '${timeZone}')::date`;
