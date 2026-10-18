import type { SensorReading } from "@/lib/types";

// Hand-rolled SVG chart (no charting library dependency, to keep the build minimal/robust) --
// plots temperature + humidity over time, shades door-open spans, and marks anomaly-flagged
// readings on the timeline, per Phase2 plan §5 "Shipment detail" requirements. The flag itself
// currently comes from the device's on-device threshold rule, not Model 1 ML scoring -- see
// backend/README.md "Model 1 status" -- so `anomaly_score` is typically null; the tooltip below
// only shows a score when one is actually present.

const WIDTH = 900;
const HEIGHT = 300;
const PAD_LEFT = 44;
const PAD_RIGHT = 44;
const PAD_TOP = 16;
const PAD_BOTTOM = 30;

export const CHART_COLORS = {
  temp: "#c7cfff",
  humidity: "#6b7cff",
  anomaly: "#ff5d73",
  door: "#ffc65c",
};

const AXIS_TEXT = "rgba(221,226,255,0.42)";
const GRID = "rgba(160,175,255,0.09)";

function scaleLinear(domain: [number, number], range: [number, number]) {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const span = d1 - d0 || 1;
  return (value: number) => r0 + ((value - d0) / span) * (r1 - r0);
}

export function LiveChart({ readings }: { readings: SensorReading[] }) {
  if (readings.length === 0) {
    return <div className="flex h-[300px] items-center justify-center text-sm text-faint">No readings yet.</div>;
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
  const tempArea = `${tempPath} L${x(tMax)},${HEIGHT - PAD_BOTTOM} L${x(tMin)},${HEIGHT - PAD_BOTTOM} Z`;

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

  const ticks = 4;
  const tempTickValues = Array.from({ length: ticks + 1 }, (_, i) => tempMin + ((tempMax - tempMin) * i) / ticks);
  const humTickValues = Array.from({ length: ticks + 1 }, (_, i) => humMin + ((humMax - humMin) * i) / ticks);
  const timeTicks = Array.from({ length: 5 }, (_, i) => tMin + ((tMax - tMin) * i) / 4);
  const fmtClock = (t: number) => new Date(t).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

  return (
    <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="w-full" role="img" aria-label="Temperature and humidity chart">
      <defs>
        <linearGradient id="fm-temp-area" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#4b61f5" stopOpacity={0.45} />
          <stop offset="100%" stopColor="#4b61f5" stopOpacity={0} />
        </linearGradient>
      </defs>

      {/* door-open shading */}
      {doorSpans.map((span, i) => {
        const w = Math.max(2, x(span.end) - x(span.start));
        return (
          <g key={`door-${i}`}>
            <rect x={x(span.start)} y={PAD_TOP} width={w} height={HEIGHT - PAD_TOP - PAD_BOTTOM} fill={CHART_COLORS.door} opacity={0.1} />
            <rect x={x(span.start)} y={PAD_TOP} width={w} height={2} fill={CHART_COLORS.door} opacity={0.8} />
          </g>
        );
      })}

      {/* gridlines + temp (left) / humidity (right) axis labels */}
      {tempTickValues.map((v, i) => (
        <g key={`grid-${i}`}>
          <line x1={PAD_LEFT} x2={WIDTH - PAD_RIGHT} y1={yTemp(v)} y2={yTemp(v)} stroke={GRID} strokeWidth={1} />
          <text x={PAD_LEFT - 8} y={yTemp(v) + 3} fontSize={10} fill={AXIS_TEXT} textAnchor="end" fontFamily="var(--font-mono)">
            {v.toFixed(0)}°
          </text>
          {humidities.length > 0 && (
            <text x={WIDTH - PAD_RIGHT + 8} y={yHum(humTickValues[i]) + 3} fontSize={10} fill={AXIS_TEXT} fontFamily="var(--font-mono)">
              {humTickValues[i].toFixed(0)}%
            </text>
          )}
        </g>
      ))}

      {/* temperature area */}
      <path d={tempArea} fill="url(#fm-temp-area)" />

      {/* humidity line (secondary axis) */}
      {humPoints.length > 1 && (
        <path d={humPath} fill="none" stroke={CHART_COLORS.humidity} strokeWidth={1.25} strokeDasharray="4 3" opacity={0.85} />
      )}

      {/* temperature line */}
      <path d={tempPath} fill="none" stroke={CHART_COLORS.temp} strokeWidth={1.75} strokeLinejoin="round" />

      {/* anomaly markers */}
      {anomalies.map((r) => (
        <g key={r.id}>
          <circle cx={x(new Date(r.ts).getTime())} cy={yTemp(r.temp_c)} r={7} fill={CHART_COLORS.anomaly} opacity={0.18} />
          <circle cx={x(new Date(r.ts).getTime())} cy={yTemp(r.temp_c)} r={3} fill={CHART_COLORS.anomaly} stroke="#05071a" strokeWidth={1}>
            <title>
              {r.anomaly_score != null
                ? `Anomaly at ${new Date(r.ts).toLocaleString()} (Model 1 score ${r.anomaly_score.toFixed(3)})`
                : `Anomaly at ${new Date(r.ts).toLocaleString()} (device threshold rule)`}
            </title>
          </circle>
        </g>
      ))}

      {/* x-axis time labels */}
      {timeTicks.map((t, i) => (
        <text
          key={`t-${i}`}
          x={x(t)}
          y={HEIGHT - 8}
          fontSize={10}
          fill={AXIS_TEXT}
          fontFamily="var(--font-mono)"
          textAnchor={i === 0 ? "start" : i === timeTicks.length - 1 ? "end" : "middle"}
        >
          {fmtClock(t)}
        </text>
      ))}
    </svg>
  );
}
