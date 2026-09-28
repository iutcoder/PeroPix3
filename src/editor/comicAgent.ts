/** AI 조수의 **만화 캔버스 액션** — 실행하는 쪽 (설계 `docs/comic-editor-design.md` 10번).
 *
 *  ★★이름 · 설명 · 인자는 `lib/appActions.ts` 에 있다 (조수의 도구 목록은 그 파일 하나에서 뽑힌다, `scripts/gen-actions.mjs`).
 *    여기는 그 액션이 부르는 실행이다 — 편집기는 지연 로드라 액션이 부를 때 이 모듈을 싣는다.
 *  ★★사람이 누르는 것과 **같은 스토어 함수**를 부른다 (`appendConti` · `setPanelGen` · `patchCommon`). 그래서 AI 가 채운 것과
 *    직접 적은 것이 구별이 없고 (설계 10-3), 되돌리기(Ctrl+Z)도 같다.
 *  ★공통의 화풍과 외형은 **읽기만** 한다 — 고치는 액션이 없다 (설계 10-3). 배경만 더할 수 있다.
 *  ★이름을 못 찾거나 여럿이면 오류다 (`findAt` 과 같은 규칙) — 코드가 대신 고르지 않는다 */
import { err, nearBy, type ActionResult } from "../lib/actions";
import { compileBlocks, makeBlock, parseSegs, type Block } from "../lib/blocks";
import { t } from "../i18n";
import {
  BUBBLE_KINDS, LAYOUTS, WHO_BUBBLE, WHO_NARRATION, WHO_PRESET, bboxOf, genOf, pageLabel, panelPts, panelsInOrder, pointInPoly,
  type BubbleKind, type CutCast, type PanelGen,
} from "./comic";
import { curPage, pageView, useEditor, type ContiSpec, type Doc } from "./store";

/** 조수가 읽는 만화 안내 — `read_comic` 이 캔버스와 함께 돌려준다 (필요할 때만 실리게: AI 조수의 지침은 4,000자 상한이 있다, 설계 10-4).
 *  ★만화 제작기 플러그인의 기획 지시문(`core.py` 의 `DIRECTOR`)을 이 도구의 칸에 맞춰 옮겼다 */
export const COMIC_GUIDE = `PeroPix comic canvas guide.
You storyboard manga pages on the user's comic canvas in the image editor. You never generate images; the user generates each cut afterwards.
Workflow:
1. read_comic first. The common section is the user's: never change the style prompt or any character's appearance tags.
2. Add pages one at a time with add_comic_page, continuing the story after the last page (the tool fills the last page if it is still empty). Stop when the requested page count or the story is done. After each page reply in one or two Korean sentences.
3. If a scene needs a place that is not in common.backgrounds, first add it with add_comic_background (Korean name; tags = location, time of day, lighting, weather). Reuse existing backgrounds by name whenever they fit.
4. Later changes the user asks for go through edit_comic_cut, one cut at a time.
Keep the user's story, beats, tone and ending; do not add unrelated events. If the story is adult-rated keep that rating everywhere: depict sexual scenes uncensored at the story's own level with explicit Danbooru tags for each visible participant, starting such cuts with nsfw, uncensored. Adults only.
Page layout (add_comic_page):
- cuts are in READING order. Give every cut a distinct beat and show one moment per cut. In rtl the first cut of each row is the rightmost, and a column of stacked cuts is read top to bottom before moving left. Tall cuts or insets may span several rows.
- box = [x, y, w, h] normalized to the page's drawing frame (0..1, x+w<=1, y+h<=1). Boxes may touch; the tool inserts the gutters.
- Choose the number of cuts from the story, not a default of four; max cuts is a ceiling, not a target. Use unequal areas: tall cuts (h > w) beside a column of short ones, wide strips, one dominant image with small reaction insets. A quiet beat may need one large image. Do not repeat the previous page's skeleton; build at least one page in three around a tall cut.
- With template composition, pass layout (single, two-rows, three-rows, four-grid, four-rows, hero-top, hero-bottom, six-grid, two-cols, tall-left, tall-right) instead of boxes, with exactly that many cuts.
Per cut:
- summary: one Korean sentence for the beat (not sent to the image model).
- background: a common background name, or empty.
- tags: only what this cut adds: 1..3 framing tags (wide shot, full body, cowboy shot, upper body, close-up, face focus, hand focus, from above, from below, from side, from behind, pov) plus props or weather that differ from the background. Vary framing: establishing wide shots, medium two-shots, reaction close-ups, detail inserts.
- cast: one entry per visible subject. who = the character's name from read_comic. tags = pose, gesture, gaze and expression for that moment (<=8); never appearance tags (the tool adds the character's appearance). x, y = the subject's center inside the cut (0.05..0.95). When subjects touch (hug, kiss, carrying, sex) put them about 0.1..0.25 apart around the contact; when they only talk keep them clearly apart. The same character may appear twice in one cut. No cast means scenery.
Dialogue: follow the user's choice.
- speech bubbles (editor): put lines in bubbles = {cut, kind: speech|thought|shout|whisper|narration, text, x, y, tail}. x, y = bubble center inside the cut (0..1); tail = {x, y} pointing at the speaker's mouth (omit for narration). Keep lines short, leave room around faces, at most ~600 characters per page.
- drawn in the image (NAI): add cast entries with who = "bubble" whose tags are the line in double quotes ("왔어?"), placed near the speaker, or who = "narration" for narration boxes. The tool adds the no humans, speech bubble / narration box tags.
- none: no dialogue.
Tags: Danbooru spelling, lowercase, comma separated. No sentences, quality tags, medium tags, subject counts or negative tags. Budgets per cut: tags <=6, cast tags <=8, at most 6 cast entries.`;

/** 콘티를 깔 캔버스 — AI 콘티가 도는 중이면 그 캔버스, 아니면 지금 보고 있는 만화 캔버스 */
async function target(): Promise<Doc | { error: ReturnType<typeof err>["error"] }> {
  const s = useEditor.getState();
  await s.ready;
  const st = useEditor.getState();
  const d = st.docs.find((x) => x.id === st.contiBusy) ?? st.doc();
  if (!d?.comic) return err("not_found", "만화 캔버스가 열려 있지 않습니다. 이미지 편집에서 만화 캔버스를 연 뒤에 다시 시켜 주세요.", { retry: "never" });
  return d;
}

/** 캐릭터 이름 — 카드 이름, 비었으면 화면과 같은 「캐릭터 N」 */
const charName = (d: Doc, i: number) => d.comic!.common.chars[i].name || t("cards.charN", { n: i + 1 });
/** 컷 상자를 기본 틀 안의 비율로 (읽을 때와 깔 때가 같은 좌표를 쓴다) */
function frameBox(d: Doc, p: { x: number; y: number; w: number; h: number; panel?: { pts: [number, number][] } }): number[] {
  const f = d.comic!.frame;
  const b = bboxOf(panelPts(p, p.panel!.pts));
  const r = (v: number) => Math.round(v * 1000) / 1000;
  return [r((b.x - f.x) / f.w), r((b.y - f.y) / f.h), r(b.w / f.w), r(b.h / f.h)];
}
const tagsOf = (b: Block[]) => compileBlocks(b);
const blockOf = (text: string): Block[] => (text.trim() ? [makeBlock("", [], { open: true, tags: parseSegs(text), src: text })] : []);
const clamp = (v: unknown, lo: number, hi: number, dflt: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};

/* ── 읽기 ─────────────────────────────────────────────────────── */

export async function readComic(): Promise<ActionResult> {
  const d = await target();
  if ("error" in d) return d;
  const c = d.comic!;
  const common = c.common;
  const who = (x: CutCast) => {
    if (x.who === WHO_NARRATION) return "narration";
    if (x.who === WHO_BUBBLE) return "bubble";
    const i = common.chars.findIndex((k) => k.id === x.who);
    return i >= 0 ? charName(d, i) : "?";
  };
  const pages = c.pages.map((pid, pi) => {
    const pv = pageView(d, pid);
    const cuts = panelsInOrder(pv.layers, c.dir, d.h);
    return {
      page: pi + 1,
      cuts: cuts.map((p, i) => {
        const g = genOf(p.panel);
        return {
          cut: i + 1,
          box: frameBox(d, p),
          summary: g.summary,
          background: g.bg ? (common.bgs.find((b) => b.id === g.bg)?.label ?? "") : "",
          tags: tagsOf(g.blocks),
          cast: g.cast.map((x) => ({ who: who(x), tags: tagsOf(x.blocks), x: Math.round(x.x * 100) / 100, y: Math.round(x.y * 100) / 100 })),
          images: d.layers.filter((l) => l.clip === p.id && !l.draw).length,
        };
      }),
      bubbles: pv.layers.filter((l) => l.bubble).map((l) => {
        const b = l.bubble!;
        const at = { x: b.body.x + b.body.w / 2, y: b.body.y + b.body.h / 2 };
        const i = cuts.findIndex((p) => pointInPoly(at, panelPts(p, p.panel!.pts)));
        return { cut: i + 1 || null, kind: b.kind, text: b.value };
      }),
    };
  });
  const nCuts = pages.reduce((a, p) => a + p.cuts.length, 0);
  return {
    ok: true,
    did: `「${d.name}」 · 페이지 ${pages.length} · 컷 ${nCuts} · 캐릭터 ${common.chars.length} · 배경 ${common.bgs.length}`,
    canvas: { name: d.name, size: [d.w, d.h], reading: c.dir, pages: c.pages.length, current_page: c.pages.indexOf(curPage(d) ?? "") + 1 },
    common: {
      style: common.style.name,
      style_tags: tagsOf(common.base),
      negative: tagsOf(common.uc),
      characters: common.chars.map((ch, i) => ({ name: charName(d, i), appearance: tagsOf(ch.prompt) })),
      backgrounds: common.bgs.map((b) => ({ name: b.label, tags: tagsOf([{ ...b, on: true }]) })),
    },
    pages,
    guide: COMIC_GUIDE,
  };
}

/* ── 이름 풀기 ─────────────────────────────────────────────────── */

type Miss = { error: ReturnType<typeof err>["error"] };

/** 배경 이름 → id. 빈 값은 「없음」. `extra` 는 이번에 함께 더하는 배경 */
function bgId(d: Doc, name: unknown, extra: Block[]): string | null | Miss {
  const n = String(name ?? "").trim();
  if (!n) return null;
  const all = [...d.comic!.common.bgs, ...extra];
  const hit = all.filter((b) => b.label === n);
  const loose = hit.length ? hit : all.filter((b) => b.label.toLowerCase() === n.toLowerCase());
  if (loose.length === 1) return loose[0].id;
  if (loose.length > 1) return err("ambiguous", `같은 이름의 배경이 여럿입니다: ${n}`, { given: n, candidates: loose.map((b) => b.label) });
  return err("not_found", `공통에 그런 배경이 없습니다: ${n}. 먼저 add_comic_background 로 더하거나 있는 이름을 쓰세요.`, { given: n, candidates: nearBy(n, all.map((b) => b.label)) });
}

/** 캐릭터 프롬프트 칸 하나 — `who` 는 캐릭터 이름 · narration · bubble */
function castOf(d: Doc, raw: unknown, i: number, n: number): CutCast | Miss {
  const o = (raw ?? {}) as Record<string, unknown>;
  const w = String(o.who ?? "").trim();
  const special = /^(narration|내레이션|나레이션)$/i.test(w) ? WHO_NARRATION : /^(bubble|speech|말풍선)$/i.test(w) ? WHO_BUBBLE : null;
  let whoId = special;
  if (!whoId) {
    const chars = d.comic!.common.chars;
    const names = chars.map((_, k) => charName(d, k));
    const exact = names.map((nm, k) => (nm === w ? k : -1)).filter((k) => k >= 0);
    const loose = exact.length ? exact : names.map((nm, k) => (nm.toLowerCase() === w.toLowerCase() ? k : -1)).filter((k) => k >= 0);
    if (loose.length !== 1)
      return err(loose.length ? "ambiguous" : "not_found", `공통에 그런 캐릭터가 없습니다: ${w} (캐릭터 이름 · narration · bubble 중 하나)`, { given: w, candidates: nearBy(w, [...names, "narration", "bubble"]) });
    whoId = chars[loose[0]].id;
  }
  let text = String(o.tags ?? "").trim();
  // ★내레이션 · 말풍선은 미리 드는 칩을 앞에 둔다 (사람이 「+ 내레이션」을 눌렀을 때와 같은 칸이 되게)
  if (special && !text.includes(special === WHO_NARRATION ? "narration box" : "speech bubble")) text = [WHO_PRESET[special], text].filter(Boolean).join(", ");
  const spread = n <= 1 ? 0.5 : 0.2 + (0.6 * i) / (n - 1);
  return {
    key: `k${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
    who: whoId,
    x: clamp(o.x, 0.05, 0.95, spread),
    y: clamp(o.y, 0.05, 0.95, 0.55),
    blocks: blockOf(text),
  };
}

/** 컷 하나의 생성 설정 (장면 요약 · 배경 · 컷 태그 · 캐릭터 프롬프트) */
function genFrom(d: Doc, o: Record<string, unknown>, extra: Block[]): Omit<PanelGen, "takes"> | Miss {
  const bg = bgId(d, o.background, extra);
  if (bg && typeof bg === "object") return bg;
  const list = Array.isArray(o.cast) ? o.cast : [];
  const cast: CutCast[] = [];
  for (const [i, x] of list.entries()) {
    const c = castOf(d, x, i, list.length);
    if ("error" in c) return c;
    cast.push(c);
  }
  return { summary: String(o.summary ?? "").trim(), bg: bg as string | null, blocks: blockOf(String(o.tags ?? "")), cast };
}

/* ── 쓰기 ─────────────────────────────────────────────────────── */

export async function addComicBackground(a: Record<string, unknown>): Promise<ActionResult> {
  const d = await target();
  if ("error" in d) return d;
  const name = String(a.name ?? "").trim();
  if (!name) return err("refused", "배경 이름이 비었습니다.", { retry: "never" });
  if (d.comic!.common.bgs.some((b) => b.label === name)) return err("blocked", `이미 있는 배경입니다: ${name}. 그 이름을 그대로 쓰세요.`, { retry: "never" });
  const tags = String(a.tags ?? "").trim();
  useEditor.getState().setCur(d.id);
  useEditor.getState().patchCommon((cc) => ({ ...cc, bgs: [...cc.bgs, makeBlock(name, [], { open: false, tags: parseSegs(tags), src: tags })] }));
  return { ok: true, did: `배경 「${name}」 추가`, at: { kind: "comic", doc: d.id }, undoable: false, why: "조수의 되돌리기로는 못 돌린다. 이미지 편집에서 Ctrl+Z 로 되돌린다." };
}

export async function addComicPage(a: Record<string, unknown>): Promise<ActionResult> {
  const d = await target();
  if ("error" in d) return d;
  const extra: Block[] = [];
  for (const raw of Array.isArray(a.new_backgrounds) ? a.new_backgrounds : []) {
    const o = (raw ?? {}) as Record<string, unknown>;
    const name = String(o.name ?? "").trim();
    if (!name || d.comic!.common.bgs.some((b) => b.label === name) || extra.some((b) => b.label === name)) continue;
    const tags = String(o.tags ?? "").trim();
    extra.push(makeBlock(name, [], { open: false, tags: parseSegs(tags), src: tags }));
  }
  const cuts = Array.isArray(a.cuts) ? (a.cuts as Record<string, unknown>[]) : [];
  if (!cuts.length) return err("refused", "cuts 가 비었습니다. 컷을 하나 이상 주세요.", { retry: "never" });
  const layout = String(a.layout ?? "").trim();
  if (layout && !LAYOUTS[layout]) return err("not_found", `그런 배치가 없습니다: ${layout}`, { given: layout, candidates: nearBy(layout, Object.keys(LAYOUTS).filter((k) => k !== "blank")) });
  if (layout && LAYOUTS[layout].length !== cuts.length)
    return err("refused", `배치 ${layout} 는 컷이 ${LAYOUTS[layout].length}개입니다 (받은 컷 ${cuts.length}개).`, { retry: "never" });
  const spec: ContiSpec = { cuts: [], bubbles: [], bgs: extra };
  for (const [i, o] of cuts.entries()) {
    const box = layout ? LAYOUTS[layout][i] : (Array.isArray(o.box) ? o.box : []).map(Number);
    if (box.length !== 4 || box.some((v) => !Number.isFinite(v))) return err("refused", `컷 ${i + 1} 의 box 는 [x, y, w, h] 네 숫자여야 합니다.`, { retry: "never" });
    const x = clamp(box[0], 0, 0.98, 0);
    const y = clamp(box[1], 0, 0.98, 0);
    const w = clamp(box[2], 0.02, 1 - x, 1 - x);
    const h = clamp(box[3], 0.02, 1 - y, 1 - y);
    const g = genFrom(d, o, extra);
    if ("error" in g) return g;
    spec.cuts.push({ box: [x, y, w, h], gen: g });
  }
  for (const raw of Array.isArray(a.bubbles) ? a.bubbles : []) {
    const o = (raw ?? {}) as Record<string, unknown>;
    const cut = Math.round(Number(o.cut)) - 1;
    if (!(cut >= 0 && cut < spec.cuts.length) || !String(o.text ?? "").trim()) continue;
    const kind = (BUBBLE_KINDS as readonly string[]).includes(String(o.kind)) ? (String(o.kind) as BubbleKind) : "speech";
    const tail = o.tail && typeof o.tail === "object" ? (o.tail as Record<string, unknown>) : null;
    spec.bubbles.push({
      cut, kind, text: String(o.text).trim(),
      x: clamp(o.x, 0.05, 0.95, 0.5), y: clamp(o.y, 0.05, 0.95, 0.2),
      tail: tail && kind !== "narration" ? { x: clamp(tail.x, 0, 1, 0.5), y: clamp(tail.y, 0, 1, 0.5) } : null,
    });
  }
  const st = useEditor.getState();
  if (st.cur !== d.id) st.setCur(d.id);
  const r = st.appendConti(d.id, spec);
  if (!r) return err("blocked", "페이지를 깔지 못했습니다.", { retry: "never" });
  useEditor.getState().revealPage(r.page);
  const bits = [pageLabel(r.index), `컷 ${spec.cuts.length}`];
  if (extra.length) bits.push(`배경 ${extra.length} 추가`);
  if (spec.bubbles.length) bits.push(`말풍선 ${spec.bubbles.length}`);
  return {
    ok: true,
    did: bits.join(" · "),
    page: r.index + 1,
    filled_empty_page: r.reused,
    at: { kind: "comic", doc: d.id, page: r.page },
    undoable: false,
    why: "조수의 되돌리기로는 못 돌린다. 이미지 편집에서 Ctrl+Z 로 되돌린다.",
  };
}

export async function editComicCut(a: Record<string, unknown>): Promise<ActionResult> {
  const d = await target();
  if ("error" in d) return d;
  const c = d.comic!;
  const pi = Math.round(Number(a.page)) - 1;
  if (!(pi >= 0 && pi < c.pages.length)) return err("not_found", `페이지 ${a.page} 가 없습니다 (1~${c.pages.length}).`, { retry: "never" });
  const cuts = panelsInOrder(pageView(d, c.pages[pi]).layers, c.dir, d.h);
  const ci = Math.round(Number(a.cut)) - 1;
  const p = cuts[ci];
  if (!p) return err("not_found", `${pageLabel(pi)} 에 컷 ${a.cut} 이 없습니다 (1~${cuts.length}).`, { retry: "never" });
  const patch: Partial<PanelGen> = {};
  if (typeof a.summary === "string") patch.summary = a.summary.trim();
  if (typeof a.tags === "string") patch.blocks = blockOf(a.tags);
  if (a.background !== undefined) {
    const bg = bgId(d, a.background, []);
    if (bg && typeof bg === "object") return bg;
    patch.bg = bg as string | null;
  }
  if (Array.isArray(a.cast)) {
    const cast: CutCast[] = [];
    for (const [i, x] of a.cast.entries()) {
      const one = castOf(d, x, i, a.cast.length);
      if ("error" in one) return one;
      cast.push(one);
    }
    patch.cast = cast;
  }
  if (!Object.keys(patch).length) return err("refused", "고칠 값이 없습니다 (summary · background · tags · cast).", { retry: "never" });
  const st = useEditor.getState();
  if (st.cur !== d.id) st.setCur(d.id);
  st.setPanelGen(p.id, patch);
  st.selectLayer(p.id);
  st.revealPage(c.pages[pi]);
  return {
    ok: true,
    did: `${pageLabel(pi)} 컷 ${ci + 1} 고침 (${Object.keys(patch).join(" · ")})`,
    at: { kind: "comic", doc: d.id, page: c.pages[pi] },
    undoable: false,
    why: "조수의 되돌리기로는 못 돌린다. 이미지 편집에서 Ctrl+Z 로 되돌린다.",
  };
}
