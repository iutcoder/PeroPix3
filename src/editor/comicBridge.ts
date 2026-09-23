/** 플러그인 ↔ 만화 페이지 캔버스 — 서랍 페이지가 부르는 창구 둘과 알림 하나 (설계 `docs/comic-editor-design.md` 10-3).
 *
 *  · `comicPage()` — 지금 보고 있는 만화 캔버스를 읽는다 (용지 크기 · 읽는 방향 · 컷 모양). 「지금 컷에 맞춤」의 입력이다.
 *  · `applyComic(payload)` — 콘티를 깐다. 첫 장은 지금 캔버스에 **되돌리기 한 번으로 취소되게**, 나머지는 새 만화 캔버스로.
 *  · 캔버스가 바뀌거나 컷 구성이 바뀌면 서랍 iframe 에 `{ event: "comicPage", page }` 를 보낸다 (`peropix.onComicPage`).
 *  ★앱에 만화 제작기 전용 경로를 두지 않는다 (`docs/dev-plugin-parity.md`) — 받는 모양만 정하고 누가 부르든 같다.
 *  ★좌표는 전부 캔버스(또는 그 컷 상자) 크기에 대한 0~1 비율이다. 픽셀로 주고받으면 캔버스 크기를 바꾸는 순간 어긋난다. */
import { t } from "../i18n";
import { pluginFrames } from "../lib/pluginHost";
import { useUi } from "../store/ui";
import { bboxOf, frameOf, panelNumbers, panelPts, CAST_NEUTRAL, type ComicAddon, type Handed, type HandedGen, type Pt } from "./comic";
import { loadItem } from "./io";
import { useEditor, type ContiPage, type Doc } from "./store";

const num = (v: unknown, d = 0) => (typeof v === "number" && Number.isFinite(v) ? v : d);
const str = (v: unknown, max = 20000) => (typeof v === "string" ? v.slice(0, max) : "");
const unit = (v: unknown, d = 0.5) => Math.min(1, Math.max(0, num(v, d)));

/** 지금 캔버스의 모양 — 만화 캔버스가 아니면 null */
export function pageOf(d: Doc | null) {
  if (!d?.comic) return null;
  const nums = panelNumbers(d.layers, d.comic.dir, d.h);
  const panels = d.layers
    .filter((l) => l.panel && l.on)
    .sort((a, b) => (nums.get(a.id) ?? 0) - (nums.get(b.id) ?? 0))
    .map((l) => {
      const poly = panelPts(l, l.panel!.pts);
      const b = bboxOf(poly);
      return {
        id: l.id,
        no: nums.get(l.id) ?? 0,
        box: { x: b.x / d.w, y: b.y / d.h, w: b.w / d.w, h: b.h / d.h },
        pts: poly.map(([x, y]) => [x / d.w, y / d.h]),
        frame: frameOf(poly),
        filled: d.layers.some((x) => x.clip === l.id),
      };
    });
  const f = d.comic.frame;
  const a = d.comic.addon;
  return {
    id: d.id,
    name: d.name,
    w: d.w,
    h: d.h,
    dir: d.comic.dir,
    frame: { x: f.x / d.w, y: f.y / d.h, w: f.w / d.w, h: f.h / d.h },
    panels,
    addon: a ? { plugin: a.plugin, label: a.label, mode: a.mode, bubbles: a.bubbles, source: a.source ?? null } : null,
  };
}

export const comicPage = () => pageOf(useEditor.getState().doc());

/** 넘겨받은 프롬프트 한 컷 — 모르는 칸은 버리고 모양을 맞춘다 */
function handedOf(p: Record<string, unknown>): Handed {
  const chars = Array.isArray(p.chars) ? (p.chars as Record<string, unknown>[]) : [];
  const notes = Array.isArray(p.notes) ? (p.notes as Record<string, unknown>[]) : [];
  const empty = p.empty && typeof p.empty === "object" ? num((p.empty as Record<string, unknown>).no, 0) : 0;
  return {
    summary: str(p.summary, 600),
    base: str(p.base),
    uc: str(p.uc),
    chars: chars.map((c) => ({
      no: num(c.no),
      name: str(c.name, 100),
      color: /^#[0-9a-f]{6}$/i.test(str(c.color)) ? str(c.color) : CAST_NEUTRAL,
      prompt: str(c.prompt),
      uc: str(c.uc),
      x: unit(c.x),
      y: unit(c.y, 0.55),
      lines: Array.isArray(c.lines) ? (c.lines as unknown[]).map((x) => str(x, 400)).filter(Boolean) : [],
    })),
    notes: notes.map((n) => ({ no: num(n.no), text: str(n.text, 400), prompt: str(n.prompt), x: unit(n.x), y: unit(n.y, 0.15) })),
    empty: empty || null,
  };
}

function genOf(g: unknown): HandedGen | undefined {
  if (!g || typeof g !== "object") return undefined;
  const o = g as Record<string, unknown>;
  const out: HandedGen = {};
  if (typeof o.model === "string") out.model = o.model;
  if (typeof o.sampler === "string") out.sampler = o.sampler;
  if (typeof o.quality_preset === "string") out.quality_preset = o.quality_preset;
  if (typeof o.uc_preset === "string") out.uc_preset = o.uc_preset;
  for (const k of ["steps", "cfg", "cfg_rescale"] as const) if (typeof o[k] === "number" && Number.isFinite(o[k])) out[k] = o[k] as number;
  return out;
}

/** 콘티를 깐다 — 페이지 그림은 여기서 먼저 읽는다 (읽기에 실패하면 아무것도 안 깐다). 깐 캔버스 id 들 */
export async function applyComic(raw: Record<string, unknown>, plugin: string, pluginName: string): Promise<{ docs: string[] }> {
  const st = useEditor.getState();
  const d = st.doc();
  if (!d?.comic) throw new Error(t("editor.bridgeNoComic"));
  const pagesIn = Array.isArray(raw.pages) ? (raw.pages as Record<string, unknown>[]) : [];
  if (!pagesIn.length) throw new Error(t("editor.bridgeNoPages"));
  const mode = raw.mode === "page" ? "page" : "cut";
  const bubbles = raw.bubbles === "editor" ? "editor" : "nai";
  const pages: ContiPage[] = [];
  for (const pg of pagesIn.slice(0, 40)) {
    let image: ContiPage["image"] = null;
    const im = pg.image as Record<string, unknown> | undefined;
    if (im && typeof im.ws === "string" && typeof im.file === "string") {
      const name = im.file.split("/").pop() || "page.png";
      const { cv } = await loadItem({ name, rel: `${im.ws}/${im.file}` });
      image = { cv, name: name.replace(/\.[^.]+$/, ""), take: { ws: im.ws, file: im.file } };
    }
    const panels = (Array.isArray(pg.panels) ? (pg.panels as Record<string, unknown>[]) : []).slice(0, 24).map((p) => ({
      match: typeof p.match === "string" ? p.match : undefined,
      pts: Array.isArray(p.pts) ? (p.pts as unknown[]).filter((q): q is [number, number] => Array.isArray(q) && q.length === 2).map(([x, y]) => [unit(x), unit(y)] as Pt) : undefined,
      handed: handedOf(p),
    }));
    const bub = (Array.isArray(pg.bubbles) ? (pg.bubbles as Record<string, unknown>[]) : []).slice(0, 60).map((b) => {
      const tail = b.tail && typeof b.tail === "object" ? (b.tail as Record<string, unknown>) : null;
      return {
        panel: Math.max(0, Math.floor(num(b.panel))),
        kind: b.kind === "narration" ? ("narration" as const) : ("speech" as const),
        text: str(b.text, 400),
        u: unit(b.u),
        v: unit(b.v, 0.2),
        tail: tail ? { u: unit(tail.u), v: unit(tail.v) } : null,
      };
    });
    pages.push({
      name: str(pg.name, 120) || undefined,
      label: str(pg.label, 200) || undefined,
      source: pg.source,
      image,
      layout: pg.layout === "own" ? "own" : "fit",
      panels,
      bubbles: bubbles === "editor" ? bub : [],
    });
  }
  const addon: ComicAddon = { plugin, name: pluginName, label: str(raw.label, 200), mode, bubbles, source: raw.source, gen: genOf(raw.gen) };
  const docs = useEditor.getState().applyConti(d.id, pages, addon);
  // 컷 모드로 깔았으면 기둥이 「넘겨받은 프롬프트」를 보이게 선택 도구로
  if (useEditor.getState().tool === "panel") useEditor.getState().setTool("select");
  useUi.getState().setMode("editor");
  return { docs };
}

/* ── 알림 — 캔버스가 바뀌거나 컷 구성이 바뀌면 서랍에 ────────────────── */

let lastSig = "";
const sigOf = (d: Doc | null) => {
  const p = pageOf(d);
  return p ? JSON.stringify([p.id, p.w, p.h, p.dir, p.panels.map((x) => [x.id, x.no, x.filled, x.box.x.toFixed(3), x.box.y.toFixed(3), x.box.w.toFixed(3), x.box.h.toFixed(3)]), p.addon?.label]) : "null";
};
useEditor.subscribe((s) => {
  const d = s.docs.find((x) => x.id === s.cur) ?? null;
  const sig = sigOf(d);
  if (sig === lastSig) return;
  lastSig = sig;
  const page = pageOf(d);
  for (const f of pluginFrames()) {
    if (f.hasAttribute("data-plugin-frame")) f.contentWindow?.postMessage({ type: "peropix", event: "comicPage", page }, "*");
  }
});
