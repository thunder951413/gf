export const DEFAULT_HOME_CITY = '苏州';

const MAX_STOPS = 12;

function invalid(message) {
  const error = new TypeError(message);
  error.status = 400;
  error.code = 'INVALID_TRAVEL_PLAN';
  return error;
}

function city(value, field) {
  if (typeof value !== 'string' || !value.trim()) throw invalid(`${field} must be a non-empty string`);
  const result = value.trim();
  if (result.length > 80) throw invalid(`${field} is too long`);
  return result;
}

function instant(value, field) {
  if (typeof value !== 'string' && !(value instanceof Date)) throw invalid(`${field} must be an ISO date`);
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw invalid(`${field} must be a valid ISO date`);
  return date;
}

function optionalText(value, field) {
  if (value == null || value === '') return null;
  return city(value, field);
}

/** Validate and clone the persistent, provider-independent itinerary shape. */
export function normalizeTravelPlan({ homeCity = DEFAULT_HOME_CITY, departAt, returnAt, stops } = {}) {
  const home = city(homeCity, 'homeCity');
  const departure = instant(departAt, 'departAt');
  const returning = instant(returnAt, 'returnAt');
  if (!(departure < returning)) throw invalid('departAt must be earlier than returnAt');
  if (!Array.isArray(stops) || stops.length < 1 || stops.length > MAX_STOPS) {
    throw invalid(`stops must contain between 1 and ${MAX_STOPS} stops`);
  }

  let previousLeave = departure;
  const normalizedStops = stops.map((source, index) => {
    if (!source || typeof source !== 'object' || Array.isArray(source)) throw invalid(`stops[${index}] must be an object`);
    const stopCity = city(source.city, `stops[${index}].city`);
    const arrive = instant(source.arriveAt, `stops[${index}].arriveAt`);
    const leave = instant(source.leaveAt, `stops[${index}].leaveAt`);
    if (arrive < previousLeave) throw invalid(`stops[${index}].arriveAt overlaps the previous leg`);
    if (!(arrive < leave)) throw invalid(`stops[${index}].arriveAt must be earlier than leaveAt`);
    if (leave > returning) throw invalid(`stops[${index}].leaveAt must not be later than returnAt`);
    previousLeave = leave;
    const lodging = optionalText(source.lodging, `stops[${index}].lodging`);
    return { city: stopCity, arriveAt: arrive.toISOString(), leaveAt: leave.toISOString(), ...(lodging ? { lodging } : {}) };
  });

  return {
    version: 1,
    homeCity: home,
    departAt: departure.toISOString(),
    returnAt: returning.toISOString(),
    stops: normalizedStops,
  };
}

function unwrap(value) {
  return value?.active && typeof value.active === 'object' ? value.active : value;
}

function legacyPlan(event) {
  const started = new Date(event?.startedAt);
  const ends = new Date(event?.endsAt);
  if (!Number.isFinite(+started) || !Number.isFinite(+ends) || !(started < ends)) return null;
  const destination = typeof event.destination === 'string' && event.destination.trim() ? event.destination.trim() : null;
  if (!destination) return null;
  const phases = Array.isArray(event.phases) ? event.phases : [];
  const timeOf = id => {
    const phase = phases.find(item => item?.id === id);
    const offset = Number(phase?.offsetHours);
    return Number.isFinite(offset) && offset >= 0 ? new Date(+started + offset * 3_600_000) : null;
  };
  const depart = timeOf('outbound') ?? started;
  const arrive = timeOf('away') ?? depart;
  const leave = timeOf('return') ?? ends;
  const home = timeOf('home') ?? ends;
  if (arrive > leave || leave > home) return null;
  return normalizeTravelPlan({
    homeCity: '苏州', departAt: depart, returnAt: home,
    stops: [{ city: destination, arriveAt: arrive, leaveAt: leave }],
  });
}

function planOf(event) {
  if (event?.travelPlan) {
    try { return normalizeTravelPlan(event.travelPlan); } catch { return null; }
  }
  return legacyPlan(event);
}

function result(plan, status, now, extra = {}) {
  return {
    status,
    currentCity: null,
    location: null,
    homeCity: plan.homeCity,
    departAt: plan.departAt,
    returnAt: plan.returnAt,
    stops: structuredClone(plan.stops),
    stopIndex: null,
    nextTransitionAt: null,
    at: now.toISOString(),
    ...extra,
  };
}

/**
 * Derive location from timestamps only. Boundaries are half-open: arrival belongs
 * to the stop, departure belongs to transit, and return belongs to home.
 */
export function travelState(eventOrLifeSnapshot, now = new Date()) {
  const event = unwrap(eventOrLifeSnapshot);
  if (!event || event.type !== 'travel') return null;
  const at = now instanceof Date ? new Date(now) : new Date(now);
  if (!Number.isFinite(+at)) throw new TypeError('now must be a valid date');
  const plan = planOf(event);
  if (!plan) return null;
  const depart = Date.parse(plan.departAt);
  const returning = Date.parse(plan.returnAt);

  if (+at < depart) return result(plan, 'planned', at, {
    currentCity: plan.homeCity, location: `${plan.homeCity}的家中`, nextTransitionAt: plan.departAt,
  });
  if (+at >= returning) return result(plan, 'returned', at, {
    currentCity: plan.homeCity, location: `${plan.homeCity}的家中`, returnedAt: plan.returnAt,
  });

  for (let index = 0; index < plan.stops.length; index += 1) {
    const stop = plan.stops[index];
    const arrive = Date.parse(stop.arriveAt);
    const leave = Date.parse(stop.leaveAt);
    if (+at < arrive) {
      const previous = index ? plan.stops[index - 1].city : plan.homeCity;
      return result(plan, index ? 'between_stops' : 'outbound', at, {
        location: `从${previous}前往${stop.city}的途中`, nextCity: stop.city,
        nextTransitionAt: stop.arriveAt,
      });
    }
    if (+at < leave) return result(plan, 'staying', at, {
      currentCity: stop.city,
      location: stop.lodging || stop.city,
      lodging: stop.lodging || `${stop.city}的住处`,
      stop: structuredClone(stop), stopIndex: index,
      nextTransitionAt: stop.leaveAt,
    });
  }

  const last = plan.stops.at(-1);
  return result(plan, 'returning', at, {
    location: `从${last.city}返回${plan.homeCity}的途中`, nextTransitionAt: plan.returnAt,
  });
}
