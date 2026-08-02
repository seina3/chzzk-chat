import type { TimeBucket } from "../db";
import { escapeHtml, formatNumber } from "./render";

export interface ChartOptions {
  /** 버킷 간격 (ms) */
  bucketMs: number;
  /** 그래프 시작 시각 (ms) */
  from: number;
  /** 그래프 끝 시각 (ms) */
  to: number;
  /** 각 막대에서 읽을 값 */
  metric: "cnt" | "total";
  /** 막대 색 */
  color: string;
  /** 값 앞에 붙일 표시 */
  unit: string;
  /** x축 눈금 문구 (짧게) */
  label: (time: number) => string;
  /** 툴팁에 쓸 문구 (날짜까지 포함) */
  tipLabel: (time: number) => string;
}

/**
 * 의존성 없이 SVG 막대그래프를 그린다.
 * 막대가 작아도 짚기 쉽도록 열 전체가 마우스에 반응하고,
 * 값은 브라우저 기본 툴팁 대신 직접 그려 지연 없이 바로 뜬다.
 */
export function renderChart(
  host: HTMLElement,
  rows: TimeBucket[],
  o: ChartOptions,
): void {
  const byBucket = new Map(rows.map((r) => [Math.floor(r.bucket), r]));
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

  const max = Math.max(...values.map((v) => v.value));
  if (max <= 0) {
    host.innerHTML = "";
    return;
  }

  const W = 100;
  const H = 40;
  const gap = count > 60 ? 0 : 0.6;
  const barW = W / count;

  const bars = values
    .map((v, i) => {
      const h = (v.value / max) * H;
      const x = i * barW + gap / 2;
      return (
        `<rect data-i="${i}" x="${x.toFixed(3)}" y="${(H - h).toFixed(3)}" ` +
        `width="${Math.max(0.4, barW - gap).toFixed(3)}" height="${h.toFixed(3)}" ` +
        `fill="${o.color}" opacity="${v.value > 0 ? 0.85 : 0.12}"/>`
      );
    })
    .join("");

  const peak = values.reduce((a, b) => (b.value > a.value ? b : a), values[0]);
  host.innerHTML =
    `<div class="chart">` +
    `<div class="chart-plot">` +
    `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img">${bars}</svg>` +
    `<div class="chart-guide hidden"></div>` +
    `<div class="chart-tip hidden"></div>` +
    `</div>` +
    `<div class="chart-axis">` +
    `<span>${escapeHtml(o.label(values[0].time))}</span>` +
    `<span class="chart-peak">최고 ${escapeHtml(o.label(peak.time))} · ${o.unit}${formatNumber(peak.value)}</span>` +
    `<span>${escapeHtml(o.label(values[values.length - 1].time))}</span>` +
    `</div></div>`;

  const plot = host.querySelector<HTMLElement>(".chart-plot")!;
  const guide = host.querySelector<HTMLElement>(".chart-guide")!;
  const tip = host.querySelector<HTMLElement>(".chart-tip")!;
  const rects = host.querySelectorAll<SVGRectElement>("rect[data-i]");
  let hovered = -1;

  // 막대 위가 아니라 그 열 어디에 마우스가 있어도 값이 뜨도록,
  // 가로 위치만으로 어느 칸인지 계산한다
  plot.addEventListener("mousemove", (e) => {
    const box = plot.getBoundingClientRect();
    const ratio = (e.clientX - box.left) / box.width;
    const i = Math.min(count - 1, Math.max(0, Math.floor(ratio * count)));
    if (i !== hovered) {
      if (hovered >= 0) {
        rects[hovered]?.setAttribute(
          "opacity",
          values[hovered].value > 0 ? "0.85" : "0.12",
        );
      }
      rects[i]?.setAttribute("opacity", "1");
      hovered = i;
      const v = values[i];
      tip.innerHTML =
        `<div class="chart-tip-time">${escapeHtml(o.tipLabel(v.time))}</div>` +
        `<div class="chart-tip-value">${o.unit}${formatNumber(v.value)}</div>`;
    }
    // 안내선과 말풍선을 마우스 위치로 옮긴다
    const x = ((i + 0.5) / count) * box.width;
    guide.style.left = `${x}px`;
    guide.classList.remove("hidden");
    tip.classList.remove("hidden");
    const tipW = tip.offsetWidth;
    tip.style.left = `${Math.min(Math.max(x - tipW / 2, 0), box.width - tipW)}px`;
  });

  plot.addEventListener("mouseleave", () => {
    guide.classList.add("hidden");
    tip.classList.add("hidden");
    if (hovered >= 0) {
      rects[hovered]?.setAttribute(
        "opacity",
        values[hovered].value > 0 ? "0.85" : "0.12",
      );
      hovered = -1;
    }
  });
}
