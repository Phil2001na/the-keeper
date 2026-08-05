/**
 * Errand route planning — ported from EggRun's delivery route-planner
 * (projects/egg-delivery/src/lib/route.ts). EggRun always has lat/lng (pin-drop
 * on a map); the Keeper only ever gets addresses/place names from conversation,
 * so stops here carry an optional address alongside optional coords and the
 * maps-link builders fall back to address text when coords are missing.
 */

export type Stop = {
  label: string;
  address?: string;
  lat?: number;
  lng?: number;
};

function toRad(d: number): number {
  return (d * Math.PI) / 180;
}

/** Great-circle distance between two points in kilometres. */
export function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const la1 = toRad(a.lat);
  const la2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function hasCoords(s: Stop): s is Stop & { lat: number; lng: number } {
  return typeof s.lat === 'number' && typeof s.lng === 'number';
}

/**
 * Greedy nearest-neighbour ordering of stops starting from `origin`. Only
 * reorders when every stop (and the origin, if given) has coordinates —
 * otherwise there is nothing to compute a distance from, so the input order
 * is returned unchanged and the caller should say so.
 */
export function orderStops(stops: Stop[], origin?: { lat: number; lng: number }): { ordered: Stop[]; reordered: boolean } {
  if (!origin || !stops.every(hasCoords)) return { ordered: stops, reordered: false };
  const remaining = [...(stops as (Stop & { lat: number; lng: number })[])];
  const ordered: Stop[] = [];
  let current = origin;
  while (remaining.length) {
    let bestIndex = 0;
    let bestDist = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const d = haversineKm(current, remaining[i]!);
      if (d < bestDist) {
        bestDist = d;
        bestIndex = i;
      }
    }
    const next = remaining.splice(bestIndex, 1)[0]!;
    ordered.push(next);
    current = next;
  }
  return { ordered, reordered: true };
}

/** Total distance in km of an ordered coordinate route. null if any leg is missing coords. */
export function routeDistanceKm(stops: Stop[], origin?: { lat: number; lng: number }): number | null {
  if (!stops.every(hasCoords)) return null;
  const coords = stops as (Stop & { lat: number; lng: number })[];
  if (coords.length === 0) return 0;
  let total = 0;
  let prev = origin ?? coords[0]!;
  const seq = origin ? coords : coords.slice(1);
  for (const s of seq) {
    total += haversineKm(prev, s);
    prev = s;
  }
  return total;
}

function point(s: Stop | { lat: number; lng: number; address?: string }): string {
  if (typeof (s as Stop).lat === 'number' && typeof (s as Stop).lng === 'number') {
    return `${(s as Stop).lat},${(s as Stop).lng}`;
  }
  return (s as Stop).address ?? '';
}

/** Google Maps directions deep link — coords where available, address text otherwise. */
export function googleMapsDirUrl(stops: Stop[], origin?: Stop | { lat: number; lng: number }): string {
  if (!stops.length) return '';
  const dest = point(stops[stops.length - 1]!);
  const waypoints = stops.slice(0, -1).map(point).filter(Boolean).join('|');
  const params = new URLSearchParams({ api: '1', destination: dest, travelmode: 'driving' });
  if (origin) params.set('origin', point(origin));
  if (waypoints) params.set('waypoints', waypoints);
  return `https://www.google.com/maps/dir/?${params.toString()}`;
}

/** Apple Maps deep link chaining stops with `+to:`. */
export function appleMapsUrl(stops: Stop[], origin?: Stop | { lat: number; lng: number }): string {
  if (!stops.length) return '';
  const daddr = stops.map(point).filter(Boolean).map(encodeURIComponent).join('+to:');
  const saddr = origin ? `saddr=${encodeURIComponent(point(origin))}&` : '';
  return `https://maps.apple.com/?${saddr}daddr=${daddr}&dirflg=d`;
}
