export interface SolarPolygonGeometry {
  type: 'Polygon';
  coordinates: [number, number][][];
}

export interface SolarLineStringGeometry {
  type: 'LineString';
  coordinates: [number, number][];
}

export interface SolarTerminatorFeature {
  type: 'Feature';
  properties: { band: TerminatorBandKind };
  geometry: SolarPolygonGeometry | SolarLineStringGeometry;
}

export interface SolarTerminatorFeatureCollection {
  type: 'FeatureCollection';
  features: SolarTerminatorFeature[];
}

export interface SubsolarPoint {
  latitude: number;
  longitude: number;
  declinationDeg: number;
}

export type TerminatorBandKind = 'horizon' | 'civil' | 'nautical' | 'astronomical' | 'night';

export interface TerminatorOverlayOptions {
  /** Number of longitude sample steps from -180 to +180 (default 180 = 2 deg resolution). */
  steps?: number;
  /** Polar closure latitude (use ~89.5 for 3D globe, ~85.0 for flat Mercator). */
  polarCapLat?: number;
}

const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;

function normalizeDegrees360(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

function normalizeLon180(lon: number): number {
  const wrapped = ((((lon + 180) % 360) + 360) % 360) - 180;
  return wrapped === -180 ? 180 : wrapped;
}

/**
 * Computes the subsolar latitude (solar declination) and longitude for a given UTC Date
 * using standard J2000.0 solar ephemeris equations (accurate within ~0.01 deg, zero network).
 */
export function computeSubsolarPoint(date: Date = new Date()): SubsolarPoint {
  const jd = date.getTime() / 86_400_000 + 2440587.5;
  const n = jd - 2451545.0;

  const meanLon = normalizeDegrees360(280.46 + 0.9856474 * n);
  const meanAnomalyRad = normalizeDegrees360(357.528 + 0.9856003 * n) * DEG_TO_RAD;

  const eclipticLonRad =
    normalizeDegrees360(
      meanLon + 1.915 * Math.sin(meanAnomalyRad) + 0.02 * Math.sin(2 * meanAnomalyRad),
    ) * DEG_TO_RAD;

  const obliquityRad = (23.439 - 0.0000004 * n) * DEG_TO_RAD;

  const sinDecl = Math.sin(obliquityRad) * Math.sin(eclipticLonRad);
  const declinationDeg = Math.asin(Math.max(-1, Math.min(1, sinDecl))) * RAD_TO_DEG;

  const raDeg =
    normalizeDegrees360(
      Math.atan2(
        Math.cos(obliquityRad) * Math.sin(eclipticLonRad),
        Math.cos(eclipticLonRad),
      ) * RAD_TO_DEG,
    );

  const gmstDeg = normalizeDegrees360(280.46061837 + 360.98564736629 * n);
  const longitude = normalizeLon180(raDeg - gmstDeg);

  return {
    latitude: Number(declinationDeg.toFixed(4)),
    longitude: Number(longitude.toFixed(4)),
    declinationDeg: Number(declinationDeg.toFixed(4)),
  };
}

/**
 * Computes the latitude on a meridian where solar elevation equals `targetElevationDeg`
 * on the boundary separating daylight from the darker side.
 */
function solveElevationBoundaryLat(
  lonDeg: number,
  subLonDeg: number,
  declRad: number,
  targetSinElev: number,
  darkSouth: boolean,
  polarCapLat: number,
): number {
  const sinDecl = Math.sin(declRad);
  const cosDecl = Math.cos(declRad);
  const cosDlon = Math.cos((lonDeg - subLonDeg) * DEG_TO_RAD);

  const evalSinElev = (latRad: number) =>
    Math.sin(latRad) * sinDecl + Math.cos(latRad) * cosDecl * cosDlon;

  // Locate extremum along this meridian: d/dlat = cos(lat)*sinDecl - sin(lat)*cosDecl*cosDlon = 0
  const extremumLat = Math.atan2(sinDecl, cosDecl * cosDlon);
  // extremumLat is in [-pi/2, pi/2] when cosDlon >= 0; wrap into [-pi/2, pi/2]
  const clampedExtremum =
    extremumLat > Math.PI / 2
      ? extremumLat - Math.PI
      : extremumLat < -Math.PI / 2
        ? extremumLat + Math.PI
        : extremumLat;

  const southLimit = -polarCapLat * DEG_TO_RAD;
  const northLimit = polarCapLat * DEG_TO_RAD;

  if (darkSouth) {
    // Dark hemisphere includes South Pole (decl >= 0).
    // If cosDlon >= 0 (day side), sinElev increases from southLimit up to clampedExtremum.
    // If cosDlon < 0 (night side), sinElev reaches minimum at clampedExtremum then increases to northLimit.
    let lo = cosDlon >= 0 ? southLimit : Math.max(southLimit, clampedExtremum);
    let hi = cosDlon >= 0 ? Math.min(northLimit, clampedExtremum) : northLimit;

    if (lo > hi) {
      const tmp = lo;
      lo = hi;
      hi = tmp;
    }

    const vLo = evalSinElev(lo);
    const vHi = evalSinElev(hi);

    if (vLo >= targetSinElev) return -polarCapLat;
    if (vHi <= targetSinElev) return polarCapLat;

    for (let i = 0; i < 20; i += 1) {
      const mid = (lo + hi) * 0.5;
      if (evalSinElev(mid) < targetSinElev) {
        lo = mid;
      } else {
        hi = mid;
      }
    }
    return Math.max(-polarCapLat, Math.min(polarCapLat, ((lo + hi) * 0.5) * RAD_TO_DEG));
  }

  // Dark hemisphere includes North Pole (decl < 0).
  // If cosDlon >= 0 (day side), sinElev peaks at clampedExtremum then decreases to northLimit.
  // If cosDlon < 0 (night side), sinElev decreases from southLimit down to clampedExtremum.
  let lo = cosDlon >= 0 ? Math.max(southLimit, clampedExtremum) : southLimit;
  let hi = cosDlon >= 0 ? northLimit : Math.min(northLimit, clampedExtremum);

  if (lo > hi) {
    const tmp = lo;
    lo = hi;
    hi = tmp;
  }

  const vLo = evalSinElev(lo);
  const vHi = evalSinElev(hi);

  if (vHi >= targetSinElev) return polarCapLat;
  if (vLo <= targetSinElev) return -polarCapLat;

  for (let i = 0; i < 20; i += 1) {
    const mid = (lo + hi) * 0.5;
    if (evalSinElev(mid) > targetSinElev) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return Math.max(-polarCapLat, Math.min(polarCapLat, ((lo + hi) * 0.5) * RAD_TO_DEG));
}

function buildElevationCurve(
  subsolar: SubsolarPoint,
  elevationDeg: number,
  steps: number,
  polarCapLat: number,
): [number, number][] {
  // Nudge exact equinox slightly away from 0 so hemisphere orientation is deterministic
  const safeDeclDeg =
    Math.abs(subsolar.declinationDeg) < 0.002
      ? subsolar.declinationDeg >= 0
        ? 0.002
        : -0.002
      : subsolar.declinationDeg;
  const darkSouth = safeDeclDeg >= 0;
  const declRad = safeDeclDeg * DEG_TO_RAD;
  const targetSinElev = Math.sin(elevationDeg * DEG_TO_RAD);

  const coords: [number, number][] = [];
  for (let i = 0; i <= steps; i += 1) {
    const lon = -180 + (360 * i) / steps;
    const lat = solveElevationBoundaryLat(
      lon,
      subsolar.longitude,
      declRad,
      targetSinElev,
      darkSouth,
      polarCapLat,
    );
    coords.push([Number(lon.toFixed(3)), Number(lat.toFixed(4))]);
  }
  return coords;
}

function buildDarkCapPolygon(
  curve: [number, number][],
  darkSouth: boolean,
  polarCapLat: number,
): [number, number][] {
  const poleLat = darkSouth ? -polarCapLat : polarCapLat;
  const ring: [number, number][] = [...curve, [180, poleLat], [-180, poleLat], curve[0]];
  return ring;
}

function buildThinRibbonPolygon(
  outerCurve: [number, number][],
  innerCurve: [number, number][],
): [number, number][] {
  const reversedInner = [...innerCurve].reverse();
  return [...outerCurve, ...reversedInner, outerCurve[0]];
}

/**
 * Generates realistic orbital Day/Night Terminator GeoJSON features:
 * - `civil`: ultra-thin warm sunset/sunrise rim (0° to -4° solar elevation)
 * - `nautical`: delicate rose-indigo twilight transition (-4° to -9° elevation)
 * - `astronomical`: deep twilight feather (-9° to -14° elevation)
 * - `night`: calm dark hemisphere cap (below -14° elevation)
 * - `horizon`: crisp solar terminator line along 0° elevation
 */
export function buildSolarTerminatorGeoJson(
  date: Date = new Date(),
  options: TerminatorOverlayOptions = {},
): SolarTerminatorFeatureCollection {
  const steps = Math.max(36, Math.min(360, Math.round(options.steps ?? 180)));
  const polarCapLat = Math.max(80, Math.min(89.5, options.polarCapLat ?? 89.0));
  const subsolar = computeSubsolarPoint(date);
  const darkSouth = subsolar.declinationDeg >= 0;

  const horizonCurve = buildElevationCurve(subsolar, 0, steps, polarCapLat);
  const civilCurve = buildElevationCurve(subsolar, -4.0, steps, polarCapLat);
  const nauticalCurve = buildElevationCurve(subsolar, -9.0, steps, polarCapLat);
  const astroCurve = buildElevationCurve(subsolar, -14.0, steps, polarCapLat);

  const features: SolarTerminatorFeature[] = [
    {
      type: 'Feature',
      properties: { band: 'night' },
      geometry: {
        type: 'Polygon',
        coordinates: [buildDarkCapPolygon(astroCurve, darkSouth, polarCapLat)],
      },
    },
    {
      type: 'Feature',
      properties: { band: 'astronomical' },
      geometry: {
        type: 'Polygon',
        coordinates: [buildThinRibbonPolygon(nauticalCurve, astroCurve)],
      },
    },
    {
      type: 'Feature',
      properties: { band: 'nautical' },
      geometry: {
        type: 'Polygon',
        coordinates: [buildThinRibbonPolygon(civilCurve, nauticalCurve)],
      },
    },
    {
      type: 'Feature',
      properties: { band: 'civil' },
      geometry: {
        type: 'Polygon',
        coordinates: [buildThinRibbonPolygon(horizonCurve, civilCurve)],
      },
    },
    {
      type: 'Feature',
      properties: { band: 'horizon' },
      geometry: {
        type: 'LineString',
        coordinates: horizonCurve,
      },
    },
  ];

  return {
    type: 'FeatureCollection',
    features,
  };
}
