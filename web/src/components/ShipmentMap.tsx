"use client";

// GPS map (plan §5's correction: "use the phone's own GPS via the Geolocation API instead of
// new hardware" -- the phone-bridge captures lat/lng from `navigator.geolocation` while live and
// includes it in /ingest readings; see phone-bridge/js/geo.js). No mapping library and no API
// key: a plain OpenStreetMap "export/embed" iframe, per the plan's explicit instruction.

import { EmptyState } from "./StateViews";
import { ArrowUpRightIcon } from "./Icons";

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
      <div className="relative overflow-hidden rounded-[3px] border border-line">
        {/* invert + hue-rotate turns the light OSM tiles into a navy map that matches the UI
            while keeping the marker's original hue */}
        <iframe
          title="Shipment location"
          className="h-72 w-full"
          src={embedUrl}
          style={{ border: 0, filter: "invert(0.92) hue-rotate(180deg) saturate(1.3) brightness(0.9) contrast(0.95)" }}
          loading="lazy"
        />
        <div className="pointer-events-none absolute inset-0 shadow-[inset_0_0_40px_rgba(5,7,26,0.7)]" />
      </div>
      <div className="mt-3 flex items-center justify-between text-xs">
        <span className="font-mono text-[11px] text-faint">
          {lat.toFixed(5)}, {lng.toFixed(5)}
        </span>
        <a href={viewUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-royal-300 hover:text-peri-100">
          Open larger map
          <ArrowUpRightIcon className="h-3.5 w-3.5" />
        </a>
      </div>
    </div>
  );
}
