type LineSeries = { label: string; values: number[]; stroke: string; dashed?: boolean };

export function LineChart({
  labels,
  series,
}: {
  labels: string[];
  series: LineSeries[];
}) {
  const w = 640;
  const h = 200;
  const pad = { l: 36, r: 12, t: 16, b: 28 };
  const ys = series.flatMap((s) => s.values);
  const max = Math.max(1, ...ys);
  const innerW = w - pad.l - pad.r;
  const innerH = h - pad.t - pad.b;
  const n = Math.max(1, labels.length - 1);
  const x = (i: number) => pad.l + (i / n) * innerW;
  const y = (v: number) => pad.t + innerH - (v / max) * innerH;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-48" role="img" aria-label="Série temporal">
      {[0, 0.5, 1].map((t) => {
        const yy = pad.t + innerH * (1 - t);
        return (
          <g key={t}>
            <line x1={pad.l} x2={w - pad.r} y1={yy} y2={yy} stroke="#1f2937" />
            <text x={4} y={yy + 4} fill="#6b7280" fontSize="10">
              {(max * t).toFixed(0)}
            </text>
          </g>
        );
      })}
      {series.map((s) => {
        const d = s.values
          .map((v, i) => `${i === 0 ? "M" : "L"} ${x(i).toFixed(1)} ${y(v).toFixed(1)}`)
          .join(" ");
        return (
          <path
            key={s.label}
            d={d}
            fill="none"
            stroke={s.stroke}
            strokeWidth={s.dashed ? 1.5 : 2.2}
            strokeDasharray={s.dashed ? "5 4" : undefined}
          />
        );
      })}
      {labels.map((lab, i) =>
        i % 2 === 0 ? (
          <text key={lab + i} x={x(i)} y={h - 8} fill="#6b7280" fontSize="9" textAnchor="middle">
            {lab.slice(5)}
          </text>
        ) : null,
      )}
    </svg>
  );
}

export function BarChart({
  items,
  value,
}: {
  items: Array<{ label: string; value: number }>;
  value?: (n: number) => string;
}) {
  const max = Math.max(1, ...items.map((i) => i.value));
  return (
    <ul className="space-y-2">
      {items.map((item) => (
        <li key={item.label}>
          <div className="flex justify-between text-xs text-zinc-400 mb-1">
            <span>{item.label}</span>
            <span>{value ? value(item.value) : item.value}</span>
          </div>
          <div className="h-2 rounded bg-zinc-800 overflow-hidden">
            <div
              className="h-full rounded bg-sky-500"
              style={{ width: `${(item.value / max) * 100}%` }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}

const STAGE_LABEL: Record<string, string> = {
  new: "Novo",
  qualified: "Qualificado",
  nurturing: "Nutrição",
  proposal: "Proposta",
  won: "Ganho",
  lost: "Perdido",
};

export function Funnel({
  rows,
}: {
  rows: Array<{ stage: string; count: number; conversionFromPrev: number | null }>;
}) {
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <ol className="space-y-2">
      {rows.map((row) => (
        <li key={row.stage} className="flex items-center gap-3">
          <span className="w-24 text-xs text-zinc-400 shrink-0">{STAGE_LABEL[row.stage] ?? row.stage}</span>
          <div className="flex-1 h-8 bg-zinc-900 rounded overflow-hidden">
            <div
              className={`h-full flex items-center px-2 text-xs ${row.stage === "won" ? "bg-emerald-700" : row.stage === "lost" ? "bg-rose-800" : "bg-indigo-700"}`}
              style={{ width: `${Math.max(8, (row.count / max) * 100)}%` }}
            >
              {row.count}
            </div>
          </div>
          <span className="w-14 text-right text-xs text-zinc-500">
            {row.conversionFromPrev == null ? "—" : `${(row.conversionFromPrev * 100).toFixed(0)}%`}
          </span>
        </li>
      ))}
    </ol>
  );
}
