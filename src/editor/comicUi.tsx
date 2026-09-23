/** 만화 페이지의 작은 그림 부품 — 말풍선 종류 아이콘 · 첫 배치 미리보기. 도형은 굽는 것과 **같은 셈**(`comic.ts`)이다 */
import { bubbleShape, newPage, templatePanels, type BubbleKind } from "./comic";

/** 말풍선 종류 아이콘 — 옵션 줄의 종류 고르기와 레이어 목록의 썸네일이 쓴다 */
export function BubbleKindIcon({ kind, w = 24, h = 16, ink = "currentColor" }: { kind: BubbleKind; w?: number; h?: number; ink?: string }) {
  const narration = kind === "narration";
  const body = { x: narration ? 10 : 12, y: narration ? 6 : 5, w: narration ? 44 : 40, h: narration ? 22 : 24 };
  const sh = bubbleShape({ kind, body, tails: narration ? [] : [{ x: 12, y: 37, w: 8, bend: 4 }], size: 12 });
  return (
    <svg viewBox="0 0 64 40" width={w} height={h} style={{ display: "block", overflow: "visible" }}>
      <g fill="none" stroke={ink} strokeWidth={2.6} strokeDasharray={sh.dash ? "5 4" : undefined} strokeLinejoin="round">
        {[sh.body, ...sh.tails].map((d, i) => <path key={i} d={d} />)}
        {sh.dots.map(([x, y, r], i) => <circle key={`c${i}`} cx={x} cy={y} r={r} />)}
      </g>
    </svg>
  );
}

/** 첫 배치의 작은 페이지 — 새 캔버스 창의 고르기 칸과 미리보기 */
export function LayoutThumb({ layout, w, h, line = "#111" }: { layout: string; w: number; h: number; line?: string }) {
  // 실제 용지(A4 비)로 컷을 잡고 그림 크기로 줄여 그린다 — 여백·간격 비율이 실제와 같다
  const W = 1654;
  const H = 2339;
  const page = newPage({ w: W, h: H }, "rtl");
  const polys = templatePanels(page, layout);
  const f = page.frame;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width={w} height={h} style={{ display: "block" }}>
      <rect width={W} height={H} fill="#fff" />
      {!polys.length && <rect x={f.x} y={f.y} width={f.w} height={f.h} fill="none" stroke="#35a8d8" strokeWidth={14} strokeDasharray="40 30" />}
      {polys.map((p, i) => (
        <polygon key={i} points={p.map((q) => q.join(",")).join(" ")} fill="none" stroke={line} strokeWidth={Math.max(18, (W / w) * 0.9)} />
      ))}
    </svg>
  );
}
