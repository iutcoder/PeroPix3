/** 옮긴 그림을 **편집 캔버스**에도 따라 보낸다 (2026-10-01) — 원본 자리(덮어쓰기·하위 output 저장의 근거)와
 *  만화 컷의 후보. 순수 함수다 (`store/workspace.ts` 의 `carryEditor` 가 부르고, 판정이 직접 부른다).
 *
 *  `ws` 는 그림이 있던 워크스페이스, `moves` 는 그 워크스페이스 기준 옛 경로 → 새 경로, `to` 는 받는
 *  워크스페이스(탭 옮기기)다. 원본 자리는 `<워크스페이스>/<상대경로>` 로, 컷 후보는 `{ ws, file }` 로 적혀 있다.
 *  바뀐 것이 없으면 `null` 이다 (스토어에 쓰지 않아 저장이 안 일어난다). */
import type { Doc } from "../editor/store";

export function carryDocs(docs: Doc[], ws: string, moves: Record<string, string>, to?: string): Doc[] | null {
  const dst = to ?? ws;
  const head = `${ws}/`;
  let hit = false;
  const next = docs.map((d) => {
    let nd = d;
    const rel = d.src?.rel;
    const was = rel?.startsWith(head) ? moves[rel.slice(head.length)] : undefined;
    if (was) {
      nd = { ...nd, src: { ...d.src!, rel: `${dst}/${was}` } };
      hit = true;
    }
    const moved = (k: { ws: string; file: string }) => k.ws === ws && !!moves[k.file];
    if (d.layers.some((l) => l.panel?.gen?.takes.some(moved))) {
      nd = {
        ...nd,
        layers: nd.layers.map((l) => {
          const g = l.panel?.gen;
          if (!l.panel || !g || !g.takes.some(moved)) return l;
          const takes = g.takes.map((k) => (moved(k) ? { ws: dst, file: moves[k.file] } : k));
          return { ...l, panel: { ...l.panel, gen: { ...g, takes } } };
        }),
      };
      hit = true;
    }
    return nd;
  });
  return hit ? next : null;
}
