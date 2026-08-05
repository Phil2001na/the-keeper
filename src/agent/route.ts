/**
 * Turns a list of place names into a Google Maps directions link. No routing
 * math here — Google Maps already optimises turn-by-turn driving directions
 * once it has the stops; this just chains them in the order given.
 */
export function googleMapsDirUrl(stops: string[], origin?: string): string {
  if (!stops.length) return '';
  const dest = stops[stops.length - 1]!;
  const waypoints = stops.slice(0, -1).join('|');
  const params = new URLSearchParams({ api: '1', destination: dest, travelmode: 'driving' });
  if (origin) params.set('origin', origin);
  if (waypoints) params.set('waypoints', waypoints);
  return `https://www.google.com/maps/dir/?${params.toString()}`;
}
