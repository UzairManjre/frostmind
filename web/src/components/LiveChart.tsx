import type { SensorReading } from "@/lib/types";

// Hand-rolled SVG chart (no charting library dependency, to keep the build minimal/robust) --
// plots temperature + humidity over time, shades door-open spans, and marks anomaly-flagged
// readings on the timeline, per Phase2 plan §5 "Shipment detail" requirements. The flag itself
// currently comes from the device's on-device threshold rule, not Model 1 ML scoring -- see
// backend/README.md "Model 1 status" -- so `anomaly_score` is typically null; the tooltip below
// only shows a score when one is actually present.

const WIDTH = 800;
const HEIGHT = 260;
const PAD_LEFT = 44;
const PAD_RIGHT = 44;
const PAD_TOP = 16;
const PAD_BOTTOM = 28;

function scaleLinear(domain: [number, number], range: [number, number]) {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const span = d1 - d0 || 1;
  return (value: number) => r0 + ((value - d0) / span) * (r1 - r0);
}

export function LiveChart({ readings }: { readings: SensorReading[] }) {
  if (readings.length === 0) {
    return <div className="flex h-[260px] items-center justify-center text-slate-500">No readings yet.</div>;
  }

  const times = readings.map((r) => new Date(r.ts).getTime());
  const temps = readings.map((r) => r.temp_c);
  const humidities = readings.map((r) => r.humidity).filter((h): h is number => h != null);

  const tMin = Math.min(...times);
  const tMax = Math.max(...times);
  const tempMin = Math.min(...temps) - 1;
  const tempMax = Math.max(...temps) + 1;
  const humMin = humidities.length ? Math.min(...humidities) - 5 : 0;
  const humMax = humidities.length ? Math.max(...humidities) + 5 : 100;

  const x = scaleLinear([tMin, tMax], [PAD_LEFT, WIDTH - PAD_RIGHT]);
  const yTemp = scaleLinear([tempMin, tempMax], [HEIGHT - PAD_BOTTOM, PAD_TOP]);
  const yHum = scaleLinear([humMin, humMax], [HEIGHT - PAD_BOTTOM, PAD_TOP]);

  const tempPath = readings.map((r, i) => `${i === 0 ? "M" : "L"}${x(new Date(r.ts).getTime())},${yTemp(r.temp_c)}`).join(" ");

  const humPoints = readings.filter((r) => r.humidity != null);
  const humPath = humPoints
    .map((r, i) => `${i === 0 ? "M" : "L"}${x(new Date(r.ts).getTime())},${yHum(r.humidity as number)}`)
    .join(" ");

  // Door-open shaded spans: collapse consecutive door_open=true readings into rectangles.
  const doorSpans: { start: number; end: number }[] = [];
  let spanStart: number | null = null;
  readings.forEach((r, i) => {
    const t = new Date(r.ts).getTime();
    if (r.door_open) {
      if (spanStart === null) spanStart = t;
    } else if (spanStart !== null) {
      doorSpans.push({ start: spanStart, end: new Date(readings[i - 1].ts).getTime() });
      spanStart = null;
    }
  });
  if (spanStart !== null) doorSpans.push({ start: spanStart, end: tMax });

  const anomalies = readings.filter((r) => r.is_anomaly);

  const tempTicks = 4;
  const tempTickValues = Array.from({ length: tempTicks + 1 }, (_, i) => tempMin + ((tempMax - tempMin) * i) / tempTicks);

  return (
    <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="w-full" role="img" aria-label="Temperature and humidity chart">
      {/* door-open shading */}
      {doorSpans.map((span, i) => (
        <rect
          key={`door-${i}`}
          x={x(span.start)}
          y={PAD_TOP}
          width={Math.max(2, x(span.end) - x(span.start))}
          height={HEIGHT - PAD_TOP - PAD_BOTTOM}
          fill="#f59e0b"
          opacity={0.15}
        />
      ))}

      {/* y-axis gridlines + temp labels */}
      {tempTickValues.map((v, i) => (
        <g key={`grid-${i}`}>
          <line x1={PAD_LEFT} x2={WIDTH - PAD_RIGHT} y1={yTemp(v)} y2={yTemp(v)} stroke="#1e293b" strokeWidth={1} />
          <text x={4} y={yTemp(v) + 4} fontSize={10} fill="#64748b">
            {v.toFixed(0)}C
          </text>
        </g>
      ))}

      {/* humidity line (secondary axis) */}
      {humPoints.length > 1 && <path d={humPath} fill="none" stroke="#38bdf8" strokeWidth={1.5} opacity={0.6} />}

      {/* temperature line */}
      <path d={tempPath} fill="none" stroke="#7fd4ff" strokeWidth={2} />

      {/* anomaly markers */}
      {anomalies.map((r) => (
        <circle
          key={r.id}
          cx={x(new Date(r.ts).getTime())}
          cy={yTemp(r.temp_c)}
          r={3.5}
          fill="#ff6b6b"
          stroke="#450a0a"
          strokeWidth={0.5}
        >
          <title>
            {r.anomaly_score != null
              ? `Anomaly at ${new Date(r.ts).toLocaleString()} (Model 1 score ${r.anomaly_score.toFixed(3)})`
              : `Anomaly at ${new Date(r.ts).toLocaleString()} (device threshold rule)`}
          </title>
        </circle>
      ))}

      {/* x-axis start/end labels */}
      <text x={PAD_LEFT} y={HEIGHT - 6} fontSize={10} fill="#64748b">
        {new Date(tMin).toLocaleTimeString()}
      </text>
      <text x={WIDTH - PAD_RIGHT} y={HEIGHT - 6} fontSize={10} fill="#64748b" textAnchor="end">
        {new Date(tMax).toLocaleTimeString()}
      </text>
    </svg>
  );
}
