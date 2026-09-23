/** 만화 페이지 — **컷 생성** (설계 `docs/comic-editor-design.md` 8번 · 목업 ⑤).
 *
 *  ★★컷 하나가 곧 씬 하나다. 생성 흐름을 새로 만들지 않고 **지금 것을 지난다**: 큐(`useQueue.enqueue`) · 시드 규칙(`rounds`) ·
 *    와일드카드(`resolveShot`) · 요금(`anlasCost`) · 계정(`currentAccountId`). 생성 창구(`store/gen.generateAll`)와 같은 조립이다.
 *  · 무엇으로: 지금 워크스페이스의 생성 옵션(`useGen.params`) · 지금 탭의 베이스·UC · **컷 프롬프트** · 컷에 고른 인물(지금 탭의 캐릭터 카드).
 *  · 크기: 컷 비율에 맞춘 64 배수, 기본은 Opus 무료 한도 안 (`comic.cutSize`).
 *  · 저장: 워크스페이스에 보통 생성물처럼 — 탭 「만화 편집」 · 씬 그룹 = 캔버스 이름 · 씬 = 「컷 N」. 캔버스 밖에도 남아 갤러리·파일에서 찾는다.
 *  · 넣기: 큐가 그림을 받으면(`imageTaps`) 씬 그룹 id(`comic_<캔버스>`)와 칸 id(= 컷 레이어 id)로 그 컷을 찾아 넣는다 (`placeTake`).
 *  ★그림이 생기는 자리라 `env`(화면 구조)를 남긴다 (데스크 지침 「그림이 생기는 모든 자리가 구조를 남겨야 한다」). */
import { t } from "../i18n";
import { anlasCost } from "../lib/anlas";
import { compileBlocks, makeBlock, parseSegs, type Block } from "../lib/blocks";
import { randomSeed, rounds } from "../lib/seedRounds";
import { resolveShot } from "../lib/wildcards";
import { currentAccountId } from "../store/accounts";
import { useGen } from "../store/gen";
import { CHAR_COLOR, usePrompt } from "../store/prompt";
import { imageTaps, useQueue } from "../store/queue";
import { useSub } from "../store/sub";
import { toast } from "../store/toast";
import { wildcardPools } from "../store/wildcards";
import { useWs } from "../store/workspace";
import { bboxOf, castCenter, comicGroupId, cutSize, docOfGroup, panelNumbers, panelPts, type ComicAddon, type CutTake, type Handed } from "./comic";
import { loadItem } from "./io";
import { composite, makeCanvas, type Layer } from "./pixels";
import { useImageInput } from "../store/imageInput";
import { useEditor, type Doc } from "./store";

/** 컷의 생성 크기 — 컷 상자 비율 (`cutSize`) */
export const sizeOf = (p: Layer) => cutSize(bboxOf(panelPts(p, p.panel!.pts)), !!p.panel!.gen?.big);

/** 그 컷들을 `count` 장씩 뽑을 때의 값 — 컷마다 크기가 달라 컷마다 세어 더한다. `free` 는 전부 무료일 때만.
 *  넘겨받은 컷은 플러그인 프로젝트의 모델·스텝으로 센다 (그 값으로 나가므로) */
export function cutCost(panels: Layer[], count: number, addon?: ComicAddon, strength = 1) {
  const params = useGen.getState().params;
  const sub = useSub.getState().current();
  const opus = (sub?.tier ?? 0) >= 3;
  const usage = opus ? (sub?.usage ?? null) : null;
  let total = 0;
  let free = true;
  let overLimit = false;
  for (const p of panels) {
    const s = sizeOf(p);
    const g = p.panel?.gen?.handed ? addon?.gen : undefined;
    const c = anlasCost({
      model: g?.model ?? params.model, width: s.w, height: s.h, steps: g?.steps ?? params.steps, opus, opusExhausted: !!usage?.isNegative,
      uncachedVibes: 0, activeVibes: 0, refCount: 0, strength, count,
    });
    total += c.total;
    free &&= c.free;
    overLimit ||= c.overLimit;
  }
  return { total, free, overLimit };
}

/** 글 → 블록 하나 (넘겨받은 프롬프트를 화면 구조로 남길 때) — 원문을 `src` 로 들어 글자 그대로 되살아난다 */
const blockOf = (text: string): Block[] => (text.trim() ? [{ ...makeBlock("", [], { open: true }), tags: parseSegs(text), src: text }] : []);

/** 넘겨받은 컷의 캐릭터 슬롯 — 인물(컷 안 자리) + NAI 가 말풍선 담당이면 내레이션 슬롯 (설계 10-2) */
const handedChars = (h: Handed, addon?: ComicAddon) => [
  ...h.chars.map((c) => ({ id: `h${c.no}`, prompt: c.prompt, uc: c.uc, center: castCenter(c) })),
  ...(addon?.bubbles !== "editor" ? h.notes.map((n) => ({ id: `n${n.no}`, prompt: n.prompt, uc: "", center: castCenter(n) })) : []),
];

/** 넘겨받은 컷의 생성 옵션 — 플러그인 프로젝트의 것 (설계 10-2 「화풍·생성 옵션은 플러그인 프로젝트의 것」). 없는 값은 지금 워크스페이스 것 */
const handedGen = (addon?: ComicAddon): Record<string, unknown> => {
  const g = addon?.gen;
  if (!g) return {};
  return Object.fromEntries(Object.entries(g).filter(([, v]) => v !== undefined && v !== null && v !== ""));
};

/** 컷들을 큐에 넣는다 — 한 바퀴에 컷 전부, 그것을 `count` 번 (시드 규칙은 생성 창구와 같다).
 *  `extra` 는 컷마다 항목에 얹을 값 (컷 인페인트의 베이스 그림·마스크) */
export async function generateCuts(doc: Doc, ids: string[], count: number, extra?: (p: Layer) => Record<string, unknown>): Promise<void> {
  const ws = useWs.getState().current;
  if (!ws) { toast(t("editor.cutNoWs"), "warn"); return; }
  if (!doc.comic) return;
  const panels = ids.map((id) => doc.layers.find((l) => l.id === id && l.panel)).filter((l): l is Layer => !!l);
  if (!panels.length) return;
  const params = useGen.getState().params;
  const pr = usePrompt.getState();
  const raw = pr.compiled();
  const nums = panelNumbers(doc.layers, doc.comic.dir, doc.h);
  // 프롬프트가 통째로 비면 NAI 가 거절한다 — 누르기 전에 막는다 (넘겨받은 컷은 그 베이스만 본다)
  const emptyOf = (p: Layer) => {
    const g = p.panel!.gen;
    if (g?.handed) return !g.handed.base.trim();
    return !raw.prompt.trim() && !compileBlocks(g?.blocks ?? []).trim();
  };
  if (panels.every(emptyOf)) { toast(t("editor.cutEmpty"), "warn"); return; }
  const addon = doc.comic.addon;
  const pools = wildcardPools();
  const items = rounds(Math.max(1, count), params, panels, (p, seed) => ({ ...itemOf(p, seed), ...(extra?.(p) ?? {}) }));
  function itemOf(p: Layer, seed: number) {
    const g = p.panel!.gen;
    const size = sizeOf(p);
    const n = nums.get(p.id) ?? 0;
    // ★넘겨받은 컷 — 지금 탭의 프롬프트가 아니라 플러그인이 나눠 준 프롬프트와 프로젝트의 생성 옵션으로 (설계 10-2)
    if (g?.handed) {
      const h = g.handed;
      const shot = resolveShot(pools, { prompt: h.base, uc: h.uc, chars: handedChars(h, addon) });
      return {
        ...handedGen(addon),
        cell: t("editor.panelNo", { n }),
        cell_id: p.id,
        cell_no: n,
        seed,
        width: size.w,
        height: size.h,
        prompt: shot.prompt,
        negative_prompt: shot.uc,
        characters: shot.chars.map((c) => ({ ...c, use_coord: true })),
        env: {
          prompt: {
            ...pr.snapshot(),
            base: blockOf(h.base),
            baseUc: blockOf(h.uc),
            chars: h.chars.map((c) => ({ id: `h${c.no}`, ref: null, name: c.name, color: CHAR_COLOR, thumb: null, prompt: blockOf(c.prompt), uc: blockOf(c.uc), on: true, center: castCenter(c) })),
          },
          sceneDest: "base",
          cell: { name: t("editor.panelNo", { n }), blocks: [] },
          comic: { doc: doc.id, panel: p.id, plugin: addon?.plugin ?? null },
        },
      };
    }
    const scene = compileBlocks(g?.blocks ?? []);
    // ★인물은 **지금 탭의 캐릭터 카드**에서 — 꺼 둔 카드라도 이 컷에 고르면 나온다 (컷마다 나올 사람이 다르다)
    const cast = (g?.cast ?? [])
      .map((c) => {
        const ch = pr.chars.find((x) => x.id === c.id);
        return ch ? { id: ch.id, prompt: compileBlocks(ch.prompt), uc: compileBlocks(ch.uc), center: castCenter(c) } : null;
      })
      .filter((c): c is NonNullable<typeof c> => !!c);
    const shot = resolveShot(pools, { prompt: [raw.prompt, scene].filter(Boolean).join(", "), uc: raw.uc, chars: cast });
    return {
      cell: t("editor.panelNo", { n }),
      cell_id: p.id,
      cell_no: n,
      seed,
      width: size.w,
      height: size.h,
      prompt: shot.prompt,
      negative_prompt: shot.uc,
      // ★컷 안 자리는 곧 그림 안 자리다 (그림이 컷 비율이다) — 좌표를 언제나 쓴다
      characters: shot.chars.map((c) => ({ ...c, use_coord: true })),
      // ★★이 장을 뽑은 화면 구조 — 생성 창구의 `env` 와 같은 모양에 컷 자리를 더한다.
      //   캐릭터 카드는 이 컷에 나온 것만 켜고 자리를 컷 안 자리로 둔다 (「설정 불러오기」가 그대로 되살린다)
      env: {
        prompt: {
          ...pr.snapshot(),
          chars: pr.chars.map((ch) => {
            const c = g?.cast.find((x) => x.id === ch.id);
            return c ? { ...ch, on: true, center: castCenter(c) } : { ...ch, on: false };
          }),
        },
        sceneDest: "base",
        cell: { name: t("editor.panelNo", { n }), blocks: g?.blocks ?? [] },
        comic: { doc: doc.id, panel: p.id },
      },
    };
  }
  await useQueue.getState().enqueue(
    {
      ...params,
      workspace: ws,
      account: currentAccountId(),
      tab: t("editor.comicTab"),
      scene_group: doc.name,
      scene_group_id: comicGroupId(doc.id),
      negative_prompt: raw.uc,
      characters: [],
    },
    items,
    1,
  );
  if (params.seed_mode !== "fixed") useGen.getState().set("seed", randomSeed());
}

/** 컷 인페인트의 베이스 — 그 컷 상자를 잘라 생성 크기로 (말풍선·효과음·컷 테두리는 뺀다) + **컷 모양 마스크**(사각이 아니다, 설계 8번).
 *  ★컷에 든 그림은 컷 모양으로 잘려 합성되므로 컷 레이어는 끈 채로 목록에 둔다 (`clipOf` 가 그 모양을 찾는다) */
export function cutBase(doc: Doc, p: Layer): { image: string; mask: string } {
  const size = sizeOf(p);
  const poly = panelPts(p, p.panel!.pts);
  const b = bboxOf(poly);
  const full = makeCanvas(doc.w, doc.h);
  composite({ w: doc.w, h: doc.h, layers: doc.layers.filter((l) => !l.bubble && !l.sfx).map((l) => (l.panel ? { ...l, on: false } : l)) }, full, 1);
  const img = makeCanvas(size.w, size.h);
  const g = img.getContext("2d")!;
  g.fillStyle = "#ffffff";
  g.fillRect(0, 0, size.w, size.h);
  g.imageSmoothingQuality = "high";
  g.drawImage(full, b.x, b.y, b.w, b.h, 0, 0, size.w, size.h);
  const mask = makeCanvas(size.w, size.h);
  const m = mask.getContext("2d")!;
  m.fillStyle = "#000000";
  m.fillRect(0, 0, size.w, size.h);
  m.fillStyle = "#ffffff";
  m.beginPath();
  poly.forEach(([x, y], i) => {
    const px = ((x - b.x) / Math.max(1, b.w)) * size.w;
    const py = ((y - b.y) / Math.max(1, b.h)) * size.h;
    if (i) m.lineTo(px, py);
    else m.moveTo(px, py);
  });
  m.closePath();
  m.fill();
  return { image: img.toDataURL("image/png").split(",")[1], mask: mask.toDataURL("image/png").split(",")[1] };
}

/** 컷만 인페인트한다 — 지금 그 컷에 보이는 것을 베이스로, 컷 모양 안만 다시 그린다. 결과는 그 컷의 새 후보로 돌아온다 */
export async function inpaintCuts(doc: Doc, ids: string[], count: number): Promise<void> {
  const extras = new Map<string, Record<string, unknown>>();
  const strength = useImageInput.getState().baseInpaintStrength ?? 1;
  for (const id of ids) {
    const p = doc.layers.find((l) => l.id === id && l.panel);
    if (!p) continue;
    const { image, mask } = cutBase(doc, p);
    extras.set(id, { base_image: image, base_mode: "inpaint", base_mask: mask, base_inpaint_strength: strength, base_noise: 0 });
  }
  await generateCuts(doc, [...extras.keys()], count, (p) => extras.get(p.id) ?? {});
}

/** 컷 강화의 결과가 돌아올 자리 — 그 캔버스의 그 컷 (강화 창 `EnhanceDialog` 의 `route`) */
export function cutRoute(doc: Doc, p: Layer): Record<string, unknown> {
  const n = doc.comic ? panelNumbers(doc.layers, doc.comic.dir, doc.h).get(p.id) ?? 0 : 0;
  return { tab: t("editor.comicTab"), scene_group: doc.name, scene_group_id: comicGroupId(doc.id), cell: t("editor.panelNo", { n }), cell_id: p.id, cell_no: n };
}

/** 큐가 받은 그림 — 만화 캔버스의 컷이면 그 컷에 넣는다. 저장된 그림은 후보로도 남는다 (파일이라 지워지지 않는다) */
async function onCutImage(m: Record<string, unknown>) {
  const docId = docOfGroup(m.scene_group_id as string | null);
  if (!docId) return;
  const st = useEditor.getState();
  const d = st.docs.find((x) => x.id === docId);
  const panelId = String(m.cell_id ?? "");
  if (!d?.layers.some((l) => l.id === panelId && l.panel)) return;
  const file = m.file ? String(m.file) : null;
  const ws = String(m.workspace ?? useWs.getState().current ?? "");
  const name = (file ?? String(m.cell ?? "cut")).split("/").pop()!;
  try {
    const { cv } = await loadItem(file ? { name, rel: `${ws}/${file}` } : { name, data: String(m.b64 ?? "") });
    const take: CutTake | null = file ? { ws, file } : null;
    useEditor.getState().placeTake(docId, panelId, take, cv, name.replace(/\.[^.]+$/, ""));
  } catch (e) {
    toast(t("editor.cutLoadFail", { e: String(e) }), "warn");
  }
}
imageTaps.add((m) => void onCutImage(m));

/** 후보를 누르면 그 그림으로 바꾼다 (한 걸음) */
export async function pickTake(docId: string, panelId: string, take: CutTake): Promise<void> {
  const name = take.file.split("/").pop()!;
  try {
    const { cv } = await loadItem({ name, rel: `${take.ws}/${take.file}` });
    useEditor.getState().placeTake(docId, panelId, take, cv, name.replace(/\.[^.]+$/, ""));
  } catch (e) {
    toast(t("editor.cutLoadFail", { e: String(e) }), "warn");
  }
}
