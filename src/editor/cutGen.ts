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
import { compileBlocks } from "../lib/blocks";
import { randomSeed, rounds } from "../lib/seedRounds";
import { resolveShot } from "../lib/wildcards";
import { currentAccountId } from "../store/accounts";
import { useGen } from "../store/gen";
import { usePrompt } from "../store/prompt";
import { imageTaps, useQueue } from "../store/queue";
import { useSub } from "../store/sub";
import { toast } from "../store/toast";
import { wildcardPools } from "../store/wildcards";
import { useWs } from "../store/workspace";
import { bboxOf, castCenter, comicGroupId, cutSize, docOfGroup, panelNumbers, panelPts, type CutTake } from "./comic";
import { loadItem } from "./io";
import type { Layer } from "./pixels";
import { useEditor, type Doc } from "./store";

/** 컷의 생성 크기 — 컷 상자 비율 (`cutSize`) */
export const sizeOf = (p: Layer) => cutSize(bboxOf(panelPts(p, p.panel!.pts)), !!p.panel!.gen?.big);

/** 그 컷들을 `count` 장씩 뽑을 때의 값 — 컷마다 크기가 달라 컷마다 세어 더한다. `free` 는 전부 무료일 때만 */
export function cutCost(panels: Layer[], count: number) {
  const params = useGen.getState().params;
  const sub = useSub.getState().current();
  const opus = (sub?.tier ?? 0) >= 3;
  const usage = opus ? (sub?.usage ?? null) : null;
  let total = 0;
  let free = true;
  let overLimit = false;
  for (const p of panels) {
    const s = sizeOf(p);
    const c = anlasCost({
      model: params.model, width: s.w, height: s.h, steps: params.steps, opus, opusExhausted: !!usage?.isNegative,
      uncachedVibes: 0, activeVibes: 0, refCount: 0, strength: 1, count,
    });
    total += c.total;
    free &&= c.free;
    overLimit ||= c.overLimit;
  }
  return { total, free, overLimit };
}

/** 컷들을 큐에 넣는다 — 한 바퀴에 컷 전부, 그것을 `count` 번 (시드 규칙은 생성 창구와 같다) */
export async function generateCuts(doc: Doc, ids: string[], count: number): Promise<void> {
  const ws = useWs.getState().current;
  if (!ws) { toast(t("editor.cutNoWs"), "warn"); return; }
  if (!doc.comic) return;
  const panels = ids.map((id) => doc.layers.find((l) => l.id === id && l.panel)).filter((l): l is Layer => !!l);
  if (!panels.length) return;
  const params = useGen.getState().params;
  const pr = usePrompt.getState();
  const raw = pr.compiled();
  const nums = panelNumbers(doc.layers, doc.comic.dir, doc.h);
  // 프롬프트가 통째로 비면 NAI 가 거절한다 — 누르기 전에 막는다
  if (!raw.prompt.trim() && panels.every((p) => !compileBlocks(p.panel!.gen?.blocks ?? []).trim())) { toast(t("editor.cutEmpty"), "warn"); return; }
  const pools = wildcardPools();
  const items = rounds(Math.max(1, count), params, panels, (p, seed) => {
    const g = p.panel!.gen;
    const size = sizeOf(p);
    const scene = compileBlocks(g?.blocks ?? []);
    // ★인물은 **지금 탭의 캐릭터 카드**에서 — 꺼 둔 카드라도 이 컷에 고르면 나온다 (컷마다 나올 사람이 다르다)
    const cast = (g?.cast ?? [])
      .map((c) => {
        const ch = pr.chars.find((x) => x.id === c.id);
        return ch ? { id: ch.id, prompt: compileBlocks(ch.prompt), uc: compileBlocks(ch.uc), center: castCenter(c) } : null;
      })
      .filter((c): c is NonNullable<typeof c> => !!c);
    const shot = resolveShot(pools, { prompt: [raw.prompt, scene].filter(Boolean).join(", "), uc: raw.uc, chars: cast });
    const n = nums.get(p.id) ?? 0;
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
  });
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
