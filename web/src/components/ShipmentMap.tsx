"use client";

// GPS map (plan §5's correction: "use the phone's own GPS via the Geolocation API instead of
// new hardware" -- the phone-bridge captures lat/lng from `navigator.geolocation` while live and
// includes it in /ingest readings; see phone-bridge/js/geo.js). No mapping library and no API
// key: a plain OpenStreetMap "export/embed" iframe, per the plan's explicit instruction.

import { EmptyState } from "./StateViews";

// Half-width/height of the bounding box in degrees. ~0.01 deg is roughly a 1-2km window at
// mid-latitudes -- tight enough to actually show the marker's street-level context, loose enough
// to tolerate GPS drift between readings without the marker sitting on the box edge.
const BBOX_DELTA = 0.01;

export function ShipmentMap({ lat, lng }: { lat: number | null | undefined; lng: number | null | undefined }) {
  if (lat == null || lng == null) {
    return (
      <EmptyState
        title="No location reported yet"
        hint="The phone bridge reports GPS from the driver's phone once a shipment goes live and location permission is granted. It's optional enrichment -- shipments still track normally without it."
      />
    );
  }

  const left = lng - BBOX_DELTA;
  const right = lng + BBOX_DELTA;
  const bottom = lat - BBOX_DELTA;
  const top = lat + BBOX_DELTA;
  const bbox = `${left},${bottom},${right},${top}`;
  const embedUrl = `https://www.openstreetmap.org/export/embed.html?bbox=${bbox}&layer=mapnik&marker=${lat},${lng}`;
  const viewUrl = `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=15/${lat}/${lng}`;

  return (
    <div>
      <div className="overflow-hidden rounded-lg border border-slate-800">
        <iframe
          title="Shipment location"
          className="h-64 w-full"
          src={embedUrl}
          style={{ border: 0 }}
          loading="lazy"
        />
      </div>
      <div className="mt-2 flex items-center justify-between text-xs text-slate-500">
        <span>
          {lat.toFixed(5)}, {lng.toFixed(5)}
        </span>
        <a href={viewUrl} target="_blank" rel="noreferrer" className="text-sky-300 hover:underline">
          Open larger map
        </a>
      </div>
    </div>
  );
}
