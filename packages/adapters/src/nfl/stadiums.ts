/**
 * Stadium reference data.
 *
 * Coordinates, roof and surface for every venue, kept here as data because it
 * is stable, public and verifiable, and because a weather lookup needs a
 * latitude before it can say anything. A dome is the single most important
 * field: it makes every wind and precipitation figure irrelevant, and a
 * screen that applies a wind penalty indoors is worse than one with no
 * weather at all.
 */

export interface Stadium {
  team: string;
  name: string;
  lat: number;
  lon: number;
  /** Fixed roof or fully retractable-and-usually-closed. */
  indoors: boolean;
  surface: 'GRASS' | 'TURF';
}

export const STADIUMS: Record<string, Stadium> = {
  ARI: { team: 'ARI', name: 'State Farm Stadium', lat: 33.5276, lon: -112.2626, indoors: true, surface: 'GRASS' },
  ATL: { team: 'ATL', name: 'Mercedes-Benz Stadium', lat: 33.7554, lon: -84.4008, indoors: true, surface: 'TURF' },
  BAL: { team: 'BAL', name: 'M&T Bank Stadium', lat: 39.2780, lon: -76.6227, indoors: false, surface: 'GRASS' },
  BUF: { team: 'BUF', name: 'Highmark Stadium', lat: 42.7738, lon: -78.7870, indoors: false, surface: 'TURF' },
  CAR: { team: 'CAR', name: 'Bank of America Stadium', lat: 35.2258, lon: -80.8528, indoors: false, surface: 'TURF' },
  CHI: { team: 'CHI', name: 'Soldier Field', lat: 41.8623, lon: -87.6167, indoors: false, surface: 'GRASS' },
  CIN: { team: 'CIN', name: 'Paycor Stadium', lat: 39.0955, lon: -84.5161, indoors: false, surface: 'TURF' },
  CLE: { team: 'CLE', name: 'Huntington Bank Field', lat: 41.5061, lon: -81.6995, indoors: false, surface: 'GRASS' },
  DAL: { team: 'DAL', name: 'AT&T Stadium', lat: 32.7473, lon: -97.0945, indoors: true, surface: 'TURF' },
  DEN: { team: 'DEN', name: 'Empower Field', lat: 39.7439, lon: -105.0201, indoors: false, surface: 'GRASS' },
  DET: { team: 'DET', name: 'Ford Field', lat: 42.3400, lon: -83.0456, indoors: true, surface: 'TURF' },
  GB: { team: 'GB', name: 'Lambeau Field', lat: 44.5013, lon: -88.0622, indoors: false, surface: 'GRASS' },
  HOU: { team: 'HOU', name: 'NRG Stadium', lat: 29.6847, lon: -95.4107, indoors: true, surface: 'TURF' },
  IND: { team: 'IND', name: 'Lucas Oil Stadium', lat: 39.7601, lon: -86.1639, indoors: true, surface: 'TURF' },
  JAX: { team: 'JAX', name: 'EverBank Stadium', lat: 30.3239, lon: -81.6373, indoors: false, surface: 'GRASS' },
  KC: { team: 'KC', name: 'Arrowhead Stadium', lat: 39.0489, lon: -94.4839, indoors: false, surface: 'GRASS' },
  LV: { team: 'LV', name: 'Allegiant Stadium', lat: 36.0909, lon: -115.1833, indoors: true, surface: 'GRASS' },
  LAC: { team: 'LAC', name: 'SoFi Stadium', lat: 33.9535, lon: -118.3392, indoors: true, surface: 'TURF' },
  LAR: { team: 'LAR', name: 'SoFi Stadium', lat: 33.9535, lon: -118.3392, indoors: true, surface: 'TURF' },
  MIA: { team: 'MIA', name: 'Hard Rock Stadium', lat: 25.9580, lon: -80.2389, indoors: false, surface: 'GRASS' },
  MIN: { team: 'MIN', name: 'U.S. Bank Stadium', lat: 44.9736, lon: -93.2575, indoors: true, surface: 'TURF' },
  NE: { team: 'NE', name: 'Gillette Stadium', lat: 42.0909, lon: -71.2643, indoors: false, surface: 'TURF' },
  NO: { team: 'NO', name: 'Caesars Superdome', lat: 29.9511, lon: -90.0812, indoors: true, surface: 'TURF' },
  NYG: { team: 'NYG', name: 'MetLife Stadium', lat: 40.8135, lon: -74.0745, indoors: false, surface: 'TURF' },
  NYJ: { team: 'NYJ', name: 'MetLife Stadium', lat: 40.8135, lon: -74.0745, indoors: false, surface: 'TURF' },
  PHI: { team: 'PHI', name: 'Lincoln Financial Field', lat: 39.9008, lon: -75.1675, indoors: false, surface: 'GRASS' },
  PIT: { team: 'PIT', name: 'Acrisure Stadium', lat: 40.4468, lon: -80.0158, indoors: false, surface: 'GRASS' },
  SF: { team: 'SF', name: "Levi's Stadium", lat: 37.4033, lon: -121.9694, indoors: false, surface: 'GRASS' },
  SEA: { team: 'SEA', name: 'Lumen Field', lat: 47.5952, lon: -122.3316, indoors: false, surface: 'TURF' },
  TB: { team: 'TB', name: 'Raymond James Stadium', lat: 27.9759, lon: -82.5033, indoors: false, surface: 'GRASS' },
  TEN: { team: 'TEN', name: 'Nissan Stadium', lat: 36.1665, lon: -86.7713, indoors: false, surface: 'GRASS' },
  WSH: { team: 'WSH', name: 'Northwest Stadium', lat: 38.9077, lon: -76.8645, indoors: false, surface: 'GRASS' },
};

/** Great-circle distance in miles, for the travel figure. */
export function distanceMiles(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const R = 3958.8;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export interface Forecast {
  temperature_f: number | null;
  wind_mph: number | null;
  precipitation_in: number | null;
  /** True when the reading is a forecast rather than an observation. */
  forecast: boolean;
}

/**
 * Conditions at a stadium at kickoff.
 *
 * Indoors short-circuits before any request: there is nothing to look up, and
 * fetching a wind speed for a closed roof invites somebody downstream to use
 * it.
 */
export async function fetchForecast(
  stadium: Stadium,
  kickoff: string,
  options: { fetch_impl?: typeof fetch; request_timeout_ms?: number } = {},
): Promise<Forecast> {
  if (stadium.indoors) {
    return { temperature_f: null, wind_mph: null, precipitation_in: null, forecast: false };
  }
  const doFetch = options.fetch_impl ?? fetch;
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${stadium.lat}&longitude=${stadium.lon}` +
    `&hourly=temperature_2m,precipitation,wind_speed_10m&forecast_days=7` +
    `&temperature_unit=fahrenheit&wind_speed_unit=mph`;

  const response = await doFetch(url, {
    signal: AbortSignal.timeout(options.request_timeout_ms ?? 15_000),
    headers: { accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`open-meteo ${response.status}`);
  const body = (await response.json()) as {
    hourly?: {
      time?: string[];
      temperature_2m?: number[];
      precipitation?: number[];
      wind_speed_10m?: number[];
    };
  };

  const times = body.hourly?.time ?? [];
  if (times.length === 0) {
    return { temperature_f: null, wind_mph: null, precipitation_in: null, forecast: true };
  }

  // Nearest hour to kickoff, rather than the first hour of the forecast.
  const target = Date.parse(kickoff);
  let best = 0;
  let bestGap = Infinity;
  for (let i = 0; i < times.length; i += 1) {
    const gap = Math.abs(Date.parse(`${times[i]}Z`) - target);
    if (gap < bestGap) {
      bestGap = gap;
      best = i;
    }
  }

  return {
    temperature_f: body.hourly?.temperature_2m?.[best] ?? null,
    wind_mph: body.hourly?.wind_speed_10m?.[best] ?? null,
    precipitation_in: body.hourly?.precipitation?.[best] ?? null,
    forecast: true,
  };
}
