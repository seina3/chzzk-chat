import type { TimeBucket } from "../db";
import { escapeHtml, formatNumber } from "./render";

export interface ChartOptions {
  /** 버킷 간격 (ms) */
  bucketMs: number;
  /** 그래프에 포함할 시작 시각 (ms) */
  from: number;
  /** 그래프에 포함할 끝 시각 (ms) */
  to: number;
  /** 각 막대에서 읽을 값 */
  metric: "cnt" | "total";
  /** 막대 색 */
  color: string;
  /** 값 앞에 붙일 표시 */
  unit: string;
  /** x축 눈금 문구 */
  label: (time: number) => string;
}

/**
 * 의존성 없이 SVG 막대그래프를 그린다.
 * 비어 있는 구간도 0으로 채워 시간 흐름이 끊기지 않게 한다.
 */
export function barChartHtml(rows: TimeBucket[], o: ChartOptions): string {
  const byBucket = new Map(rows.map((r) => [r.bucket, r]));
  const first = Math.floor(o.from / o.bucketMs);
  const last = Math.floor(o.to / o.bucketMs);
  const count = Math.max(1, Math.min(last - first + 1, 400));

  const values: { time: number; value: number }[] = [];
  for (let i = 0; i < count; i++) {
    const bucket = first + i;
    const row = byBucket.get(bucket);
    values.push({
      time: bucket * o.bucketMs,
      value: row ? (o.metric === "cnt" ? row.cnt : row.total) : 0,
    });
  }

  const max = Math.max(1, ...values.map((v) => v.value));
  const W = 100; // viewBox 기준 (가로는 CSS로 늘어남)
  const H = 40;
  const gap = count > 60 ? 0 : 0.6;
  const barW = W / count;

  const bars = values
    .map((v, i) => {
      const h = (v.value / max) * H;
      const x = i * barW;
      const title = `${o.label(v.time)} · ${o.unit}${formatNumber(v.value)}`;
      return (
        `<rect x="${(x + gap / 2).toFixed(3)}" y="${(H - h).toFixed(3)}" ` +
        `width="${Math.max(0.4, barW - gap).toFixed(3)}" height="${h.toFixed(3)}" ` +
        `fill="${o.color}" opacity="${v.value > 0 ? 0.9 : 0.15}">` +
        `<title>${escapeHtml(title)}</title></rect>`
      );
    })
    .join("");

  const peak = values.reduce((a, b) => (b.value > a.value ? b : a), values[0]);
  return (
    `<div class="chart">` +
    `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img">${bars}</svg>` +
    `<div class="chart-axis">` +
    `<span>${escapeHtml(o.label(values[0].time))}</span>` +
    `<span class="chart-peak">최고 ${escapeHtml(o.label(peak.time))} · ${o.unit}${formatNumber(peak.value)}</span>` +
    `<span>${escapeHtml(o.label(values[values.length - 1].time))}</span>` +
    `</div></div>`
  );
}
