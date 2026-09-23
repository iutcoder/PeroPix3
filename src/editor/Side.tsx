import { Fragment, useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n";
import { Icon } from "../components/Icon";
import { EditableName } from "../components/EditableName";
import { DropLine } from "../components/DropLine";
import { FolderOpenButton } from "../components/FolderOpenButton";
import { Help } from "../components/Tip";
import { api, backendUrl } from "../lib/backend";
import { moveTo } from "../lib/moveTo";
import { useReorder } from "../lib/useReorder";
import { useFiles } from "../store/files";
import { toast } from "../store/toast";
import { useUi } from "../store/ui";
import { Hint, Line, Sec, box, dropFocus, num, on } from "../panels/censor/ui";
import { NO_ADJUST, hasAdjust, withRatio } from "./model";
import { thumbOf, type Layer } from "./pixels";
import { primaryOf, saveName, useEditor, whereOf, type Doc } from "./store";
import { CanvasSizeDialog, ExportPagesDialog, ImageSizeDialog } from "./dialogs";
import { BubbleKindIcon, CAST_COLORS } from "./comicUi";
import { bendable, castSpot, comicGroupId, defaultTail, hasTails, panelNumbers, panelPts, pointInPoly, type BubbleMeta, type PanelGen } from "./comic";
import { cutCost, cutRoute, generateCuts, inpaintCuts, pickTake, sizeOf } from "./cutGen";
import { EnhanceDialog } from "../panels/EnhanceDialog";
import { useImageInput } from "../store/imageInput";
import { SfxSection } from "./SfxSection";
import { HandedSection } from "./ComicAddon";
import { retryComicFonts, useComicFonts } from "./comicFonts";
import { BlockList } from "../blocks/BlockList";
import { slotBlock, slotBlocksOf } from "../lib/blocks";
import { thumbUrlOf } from "../lib/imgUrl";
import { usePrompt } from "../store/prompt";
import { useQueue } from "../store/queue";
import { useWs } from "../store/workspace";

/** 오른쪽 기둥 — 레이어 · 변형 · 보정 · 캔버스 · 저장 위치. 검열의 오른쪽 기둥과 같은 조각(`Sec`·`Line`·`box`)으로 그린다 */
export function Side({ doc }: { doc: Doc }) {
  const t = useI18n((s) => s.t);
  const s = useEditor();
  /** 으뜸(마지막에 고른 것). 여럿을 골랐으면(`many`) 변형·보정 칸은 접고 개수만 말한다 — 한 레이어의 값을 보여 주면 무엇을 고치는지 알 수 없다 */
  const sel = doc.layers.find((l) => l.id === primaryOf(doc)) ?? null;
  const many = doc.sel.length > 1;
  const adj = sel && !many ? sel.adj : NO_ADJUST;
  const [dlg, setDlg] = useState<"canvas" | "image" | "pages" | null>(null);
  const editLast = useUi((st) => st.editLast);
  const setEditLast = useUi((st) => st.setEditLast);

  const pick = async () => {
    try {
      const r = await api<{ dir: string | null }>("/api/files/pick-dir", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ start: doc.src?.path ? doc.src.path.replace(/[\\/][^\\/]*$/, "") : "" }),
      });
      if (r.dir) setEditLast({ dest: r.dir });
    } catch (e) {
      toast(String(e), "warn");
    }
  };
  /** 원본 자리가 없는 문서 — 저장 자리 셈(`whereOf`)이 「저장 폴더 지정」으로 고정한다 */
  const noHome = !doc.src;
  const where = whereOf(doc, editLast);
  const mode = where.mode;
  const whereDest = "dest" in where ? where.dest : "";
  const needDest = mode === "folder";
  /** 지금 옵션으로 **저장될 폴더** — 일괄 변환과 같은 창구(`/api/tools/convert-dest`, 변환이 쓰는 함수)에 물어 절대 경로로
   *  보여 준다 (사용자 지시 2026-09-22: 일괄 변환과 같은 모양). 자리를 모르면 비운다 — 틀린 자리를 보여 주는 것보다 낫다 */
  const [saveDir, setSaveDir] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    if (mode !== "overwrite" && !whereDest) {
      setSaveDir(null);
      return;
    }
    void api<{ dir: string | null }>("/api/tools/convert-dest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        items: doc.src ? [{ name: doc.src.name, rel: doc.src.rel, path: doc.src.path }] : [],
        mode,
        dest: mode === "folder" ? whereDest : "",
      }),
    })
      .then((r) => alive && setSaveDir(r.dir))
      .catch(() => alive && setSaveDir(null));
    return () => {
      alive = false;
    };
  }, [doc.src, mode, whereDest]);

  return (
    <div
      data-editor-side
      style={{ width: 280, flexShrink: 0, display: "flex", flexDirection: "column", gap: "var(--sp-4)", minHeight: 0 }}
    >
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column", gap: "var(--sp-5)", paddingRight: 2 }}>
        {/* ── 레이어 ── */}
        <Sec label={t("editor.layers")} help={t("editor.layersHint")}>
          <LayerList doc={doc} />
          <div style={{ display: "flex", gap: "var(--sp-2)" }}>
            <IconBtn mark="editor-layer-add" tip={t("editor.addLayer")} onClick={() => s.addLayer()}>{Icon.plus}</IconBtn>
            <IconBtn mark="editor-layer-dup" tip={t("editor.dupLayer")} disabled={!sel} onClick={() => s.dupLayer()}>{Icon.duplicate}</IconBtn>
            <IconBtn mark="editor-layer-merge" tip={t("editor.mergeDown")} disabled={!sel || doc.layers.findIndex((l) => l.id === sel.id) <= 0} onClick={() => s.mergeDown()}>{Icon.merge}</IconBtn>
            <span style={{ flex: 1 }} />
            <IconBtn mark="editor-layer-del" tip={t("editor.delLayer")} disabled={!sel} onClick={() => s.removeLayer()} danger>{Icon.trash}</IconBtn>
          </div>
        </Sec>

        {/* ── 만화 페이지: 고른 컷 · 고른 말풍선 · 컷에 든 그림 (설계 5·6·8번) ── */}
        {doc.comic && sel && !many && <ComicSections doc={doc} sel={sel} />}
        {/* 효과음 — 고른 효과음을 고치거나, 효과음 도구만 들었으면 새 효과음의 글을 고른다 (설계 7번) */}
        {doc.comic && !many && (sel?.sfx || (s.tool === "sfx" && !sel?.bubble && !sel?.panel)) && <SfxSection sel={sel?.sfx ? sel : null} />}

        {/* ── 변형 ── 컷(꼭짓점으로 고친다)·말풍선(몸통·꼬리 손잡이)은 무대에서만 고친다 */}
        {!(sel && !many && (sel.panel || sel.bubble)) && (
        <Sec label={sel && !many ? `${sel.name} · ${t("editor.transform")}` : t("editor.transform")}>
          {!sel && <Hint>{t("editor.noLayer")}</Hint>}
          {sel && many && <span data-editor-many><Hint>{t("editor.selectedN", { n: doc.sel.length })}</Hint></span>}
          {sel && !many && (
            <>
              <Line label={t("editor.pos")}>
                <NumIn mark="editor-x" value={Math.round(sel.x)} onCommit={(v) => s.patchLayer(sel.id, { x: v })} />
                <span style={{ color: "var(--ink-ghost)" }}>×</span>
                <NumIn mark="editor-y" value={Math.round(sel.y)} onCommit={(v) => s.patchLayer(sel.id, { y: v })} />
              </Line>
              <Line label={t("editor.dims")}>
                {/* ★글자 레이어는 언제나 비율대로 늘고, 늘린 만큼 글꼴 크기가 된다 (`settleText`) */}
                <NumIn mark="editor-w" value={Math.round(sel.w)} min={1} onCommit={(v) => { s.patchLayer(sel.id, s.ratioLock || sel.text || sel.sfx ? { w: v, h: withRatio(sel.w, sel.h, v) } : { w: v }); if (sel.text) s.settleText(sel.id); if (sel.sfx) s.settleSfx(sel.id); }} />
                <span style={{ color: "var(--ink-ghost)" }}>×</span>
                <NumIn mark="editor-h" value={Math.round(sel.h)} min={1} onCommit={(v) => { s.patchLayer(sel.id, s.ratioLock || sel.text || sel.sfx ? { h: v, w: withRatio(sel.h, sel.w, v) } : { h: v }); if (sel.text) s.settleText(sel.id); if (sel.sfx) s.settleSfx(sel.id); }} />
                <button
                  data-editor-ratio
                  onMouseDown={dropFocus}
                  onClick={() => s.setRatioLock(!s.ratioLock)}
                  data-tip={t("editor.ratio")}
                  style={{ ...box, ...(s.ratioLock ? on : {}), marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 4, padding: "2px 6px" }}
                >
                  {s.ratioLock ? Icon.lock : Icon.unlock}
                  {t("editor.ratio")}
                </button>
              </Line>
              <Line label={t("editor.rotate")}>
                <NumIn mark="editor-rot" value={Math.round(sel.rot)} onCommit={(v) => s.patchLayer(sel.id, { rot: ((v % 360) + 360) % 360 })} suffix="°" />
                <button data-editor-rot90 onMouseDown={dropFocus} onClick={() => s.rotate90()} style={{ ...box, display: "inline-flex", alignItems: "center", gap: 4, padding: "2px 8px" }}>
                  {Icon.rotateCw}90°
                </button>
                <button data-editor-fliph onMouseDown={dropFocus} onClick={() => s.flip("h")} data-tip={t("editor.flipH")} style={{ ...box, display: "grid", padding: "3px 6px" }}>{Icon.flipH}</button>
                <button data-editor-flipv onMouseDown={dropFocus} onClick={() => s.flip("v")} data-tip={t("editor.flipV")} style={{ ...box, display: "grid", padding: "3px 6px" }}>{Icon.flipV}</button>
              </Line>
              <Line label={t("editor.opacity")}>
                <input
                  type="range"
                  data-editor-layer-opacity
                  min={0}
                  max={100}
                  value={sel.opacity}
                  onChange={(e) => s.patchLayer(sel.id, { opacity: Number(e.target.value) }, true)}
                  onPointerDown={() => s.markBefore()}
                  style={{ flex: 1 }}
                />
                <span style={num}>{sel.opacity}</span>
              </Line>
            </>
          )}
        </Sec>
        )}

        {/* ── 보정 — 레이어의 속성이라 슬라이더 값이 **언제나** 걸린다 (사용자 지시 2026-09-22: 「적용」 없음, 초기화만) ── */}
        {!(sel && !many && (sel.panel || sel.bubble)) && (
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-2)" }}>
          <span style={{ display: "flex", alignItems: "center", gap: "var(--sp-2)", fontSize: "var(--text-xs)", fontWeight: "var(--w-semi)", color: "var(--ink-soft)" }}>
            {t("editor.adjust")}
            <Help tip={t("editor.adjustHint")} />
            <span style={{ flex: 1 }} />
            <button data-editor-adjust-reset disabled={!sel || many || !hasAdjust(adj)} onClick={() => s.resetAdjust()} style={{ ...box, padding: "1px 8px", fontSize: "var(--text-3xs)", color: "var(--ink-faint)" }}>
              {t("editor.reset")}
            </button>
          </span>
          {(
            [
              ["bri", "editor.brightness", -100, 100],
              ["con", "editor.contrast", -100, 100],
              ["sat", "editor.saturation", -100, 100],
              ["hue", "editor.hue", -180, 180],
            ] as const
          ).map(([key, label, lo, hi]) => (
            <Line key={key} label={t(label)}>
              <input
                type="range"
                data-editor-adjust={key}
                min={lo}
                max={hi}
                value={adj[key]}
                disabled={!sel || many}
                onPointerDown={() => s.markBefore()}
                onChange={(e) => s.setAdjust({ [key]: Number(e.target.value) }, true)}
                style={{ flex: 1 }}
              />
              <span style={num}>{adj[key]}</span>
            </Line>
          ))}
        </div>
        )}

        {/* ── 페이지 (만화 페이지만) ── */}
        {doc.comic && <PageSection doc={doc} onExport={() => setDlg("pages")} />}

        {/* ── 캔버스 ── */}
        <Sec label={`${t("editor.canvas")}  ${doc.w} × ${doc.h}`}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--sp-2)" }}>
            <button data-editor-canvas-size onClick={() => setDlg("canvas")} style={{ ...box, display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
              {Icon.fitBox}{t("editor.canvasSize")}
            </button>
            <button data-editor-image-size onClick={() => setDlg("image")} style={{ ...box, display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
              {Icon.scaling}{t("editor.imageSize")}
            </button>
          </div>
        </Sec>
      </div>

      {/* ── 저장 (스크롤 밖, 맨 아래 고정) ──
          ★일괄 변환의 오른쪽 기둥과 **같은 차례·모양**이다 (사용자 지시 2026-09-22): 형식이 위, 저장 위치 아래에 저장될 폴더와 「폴더 열기」 */}
      <div style={{ flexShrink: 0, display: "flex", flexDirection: "column", gap: "var(--sp-3)", borderTop: "1px solid var(--line)", paddingTop: "var(--sp-3)" }}>
        <Sec label={t("tools.format")}>
          <div style={{ display: "flex", gap: "var(--sp-2)" }}>
            {(["png", "webp"] as const).map((f) => (
              <button key={f} data-editor-fmt={f} onMouseDown={dropFocus} onClick={() => setEditLast({ fmt: f })} style={{ ...box, flex: 1, ...(editLast.fmt === f ? on : {}) }}>
                {f === "png" ? "PNG" : "WebP (Lossless)"}
              </button>
            ))}
          </div>
          <Hint><span data-editor-save-name>{t("tools.preview", { s: saveName(doc, editLast.fmt) })}</span></Hint>
        </Sec>
        <Sec label={t("tools.dest")} help={t("tools.destHint")}>
          <select
            data-editor-dest-mode
            value={mode}
            disabled={noHome}
            onChange={(e) => setEditLast({ mode: e.target.value as "overwrite" | "sub" | "folder" })}
            style={{ ...box, width: "100%" }}
          >
            <option value="overwrite">{t("tools.destOverwrite")}</option>
            <option value="sub">{t("tools.destSub")}</option>
            <option value="folder">{t("tools.destFolder")}</option>
          </select>
          {/* ★막힌 이유는 막힌 칸 **바로 아래** (사용자 지적 2026-09-22: 멀리 적혀 있어 왜 안 바뀌는지 알 수 없었다) */}
          {noHome && <Hint>{t("editor.noHome")}</Hint>}
          {mode === "overwrite" && <Hint>{t("tools.destOverwriteHint")}</Hint>}
          {needDest && (
            <button data-editor-dest-pick onClick={() => void pick()} style={{ ...box, width: "100%", textAlign: "left", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {editLast.dest || t("tools.destPick")}
            </button>
          )}
          {needDest && !editLast.dest && <Hint>{t("editor.needDest")}</Hint>}
          {/* 지금 옵션으로 저장될 폴더 + 「폴더 열기」 — 일괄 변환의 `data-convert-save-dir` 와 같은 줄 */}
          {saveDir && (
            <div data-editor-save-dir style={{ display: "flex", alignItems: "center", gap: "var(--sp-2)", minWidth: 0 }}>
              <span
                data-tip={saveDir}
                style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                         fontSize: "var(--text-2xs)", color: "var(--ink-soft)", direction: "rtl", textAlign: "left" }}
              >
                {saveDir}
              </span>
              <FolderOpenButton
                data-editor-open-dir
                tip={t("tools.openFolder")}
                onClick={() => void useFiles.getState().openDir(saveDir).catch((e) => toast(String(e), "warn"))}
              />
            </div>
          )}
        </Sec>
        <button
          data-editor-save
          disabled={s.busy}
          onClick={() => void s.save()}
          style={{
            width: "100%",
            padding: "var(--sp-2) 0",
            borderRadius: "var(--r-2)",
            border: "1px solid var(--accent)",
            background: "var(--accent)",
            color: "#fff",
            fontSize: "var(--text-xs)",
            fontWeight: "var(--w-semi)",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 6,
            opacity: s.busy ? 0.6 : 1,
          }}
        >
          {Icon.save}{t("editor.save")}
        </button>
      </div>

      {dlg === "canvas" && <CanvasSizeDialog doc={doc} onClose={() => setDlg(null)} />}
      {dlg === "image" && <ImageSizeDialog doc={doc} onClose={() => setDlg(null)} />}
      {dlg === "pages" && <ExportPagesDialog onClose={() => setDlg(null)} />}
    </div>
  );
}

/** 레이어 목록 — **위가 앞**이다 (스토어는 아래가 먼저). 차례 바꾸기는 앱의 것 하나(`useReorder`)다 — 탭·블록과 같은 끌기라
 *  끼움선(`DropLine`)도 같은 부품이다 (사용자 지시 2026-09-22).
 *  ★잔상(`DragGhost`)은 **안 그린다** (사용자 지적 2026-09-22: 커서를 따라오는 줄이 놓일 자리를 가려 어디에 놓이는지 알 수 없었다).
 *    끌리는 줄은 제자리에서 흐려지고, 놓일 자리는 끼움선 하나로 말한다 (포토샵의 레이어 판과 같다).
 *  ★줄은 눌러서 고르는 자리이기도 해서 `tapSafe` 로 잡는다 — 문턱을 넘기 전에는 클릭(고르기)·더블클릭(이름 고치기)이 산다 */
function LayerList({ doc }: { doc: Doc }) {
  const t = useI18n((s) => s.t);
  const s = useEditor();
  const rows = listRows(doc);
  const listRef = useRef<HTMLDivElement | null>(null);
  /** 화면 차례(위가 0)의 틈 번호로 받아 스토어 차례(아래가 먼저)로 넘긴다 — 셈은 앱 공통 `moveTo` */
  const move = (from: number, to: number) => s.orderLayers(moveTo(rows, from, to).map((l) => l.id).reverse());
  const { register, handleProps, dragIdx, overIdx } = useReorder(rows.length, move, { tapSafe: true, within: listRef });

  // ★만화 페이지는 묶음으로 보인다 — 말풍선 · 컷(그 컷에 든 그림이 아래로 들여 쓰인다) · 그 밖 (설계 4번 · 목업 ①).
  //   차례는 스토어가 묶음대로 맞춰 두므로(`comicStack`) 줄 사이에 머리만 끼우면 된다
  const nums = doc.comic ? panelNumbers(doc.layers, doc.comic.dir, doc.h) : null;
  const groupOf = (l: Layer) => (l.bubble ? "bubble" : l.sfx ? "sfx" : l.panel || (l.clip && doc.layers.some((p) => p.id === l.clip && p.panel)) ? "panel" : "other");
  const counts = { bubble: doc.layers.filter((l) => l.bubble).length, sfx: doc.layers.filter((l) => l.sfx).length, panel: doc.layers.filter((l) => l.panel).length, other: 0 };
  counts.other = doc.layers.length - counts.bubble - counts.sfx - doc.layers.filter((l) => groupOf(l) === "panel").length;
  const GROUP_KEY = { bubble: "editor.groupBubbles", sfx: "editor.groupSfx", panel: "editor.groupPanels", other: "editor.groupOther" } as const;
  const head = (g: "bubble" | "sfx" | "panel" | "other") => (
    <div data-editor-layer-group={g} style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px var(--sp-2) 2px", fontSize: "var(--text-3xs)", color: "var(--ink-faint)", letterSpacing: ".02em" }}>
      {t(GROUP_KEY[g])}
      <span style={{ flex: 1 }} />
      {counts[g]}
    </div>
  );
  return (
    <div ref={listRef} data-editor-layers style={{ display: "flex", flexDirection: "column", maxHeight: doc.comic ? 300 : 220, overflowY: "auto" }}>
      {rows.map((l, i) => (
        <Fragment key={l.id}>
          {nums && (i === 0 || groupOf(rows[i - 1]) !== groupOf(l)) && head(groupOf(l))}
          <DropLine on={dragIdx != null && overIdx === i} />
          <LayerRow
            no={l.panel ? nums?.get(l.id) : undefined}
            sub={l.panel ? t("editor.panelImages", { n: doc.layers.filter((x) => x.clip === l.id).length }) : undefined}
            indent={!!nums && !!l.clip && !l.panel}
            rowRef={register(i)}
            l={l}
            selected={doc.sel.includes(l.id)}
            dim={dragIdx === i}
            hp={handleProps(i)}
            // ★Ctrl+클릭은 고른 것에 넣고 빼기, 그냥 누르면 그것 하나만 (사용자 지시 2026-09-22)
            onSelect={(e) => (e.ctrlKey || e.metaKey ? s.toggleSelect(l.id) : s.selectLayer(l.id))}
            onToggle={() => s.toggleLayer(l.id)}
            onRename={(v) => s.renameLayer(l.id, v)}
            tipOn={t(l.on ? "editor.layerHide" : "editor.layerShow")}
          />
        </Fragment>
      ))}
      <DropLine on={dragIdx != null && overIdx === rows.length} />
      {!rows.length && <Hint>{t("editor.noLayers")}</Hint>}
    </div>
  );
}

/** 목록의 줄 차례 — 위가 앞(스토어 차례를 뒤집은 것). 만화 페이지는 컷 묶음만 **컷 번호 차례**로 보인다
 *  (컷의 쌓임 차례는 겹칠 때만 뜻이 있고, 목록에서 찾는 것은 번호다). 끌어 바꾸면 이 차례가 스토어로 간다 */
function listRows(doc: Doc): Layer[] {
  const rows = [...doc.layers].reverse();
  if (!doc.comic) return rows;
  const nums = panelNumbers(doc.layers, doc.comic.dir, doc.h);
  const panels = rows.filter((l) => l.panel).sort((a, b) => (nums.get(a.id) ?? 0) - (nums.get(b.id) ?? 0));
  const inPanel = (l: Layer) => !l.panel && !l.bubble && !l.sfx && !!l.clip && panels.some((p) => p.id === l.clip);
  return [
    ...rows.filter((l) => l.bubble),
    ...rows.filter((l) => l.sfx),
    ...panels.flatMap((p) => [p, ...rows.filter((l) => inPanel(l) && l.clip === p.id)]),
    ...rows.filter((l) => !l.bubble && !l.sfx && !l.panel && !inPanel(l)),
  ];
}

type Handle = ReturnType<ReturnType<typeof useReorder>["handleProps"]>;

function LayerRow({
  l, selected, dim, hp, rowRef, onSelect, onToggle, onRename, tipOn, no, indent, sub,
}: {
  l: Layer;
  /** 컷 번호 (읽는 차례) — 컷 줄에만 */
  no?: number;
  /** 컷에 든 그림 — 그 컷 아래로 들여 쓴다 */
  indent?: boolean;
  /** 컷 줄의 덧말 (「그림 N」) */
  sub?: string;
  selected: boolean;
  /** 끌리는 중 — 제자리에서 흐려진다 */
  dim?: boolean;
  /** 끌기 손잡이(`useReorder.handleProps`) */
  hp: Handle;
  rowRef: (el: HTMLElement | null) => void;
  onSelect: (e: React.PointerEvent) => void;
  onToggle: () => void;
  onRename: (v: string) => void;
  tipOn: string;
}) {
  const tPanel = (n?: number) => useI18n.getState().t("editor.panelNo", { n: n ?? "" });
  return (
    <div
      ref={rowRef}
      data-editor-layer={l.id}
      data-on={selected ? "" : undefined}
      data-text={l.text ? "" : undefined}
      {...hp}
      onPointerDown={(e) => {
        if ((e.target as HTMLElement).closest("button, input")) return;
        onSelect(e);
        hp.onPointerDown(e);
      }}
      style={{
        ...hp.style,
        display: "flex",
        alignItems: "center",
        gap: "var(--sp-2)",
        padding: "3px var(--sp-2)",
        paddingLeft: indent ? 22 : undefined,
        margin: "1px 0",
        borderRadius: "var(--r-2)",
        border: `1px solid ${selected ? "var(--accent)" : "transparent"}`,
        background: selected ? "var(--accent-bg)" : "var(--bg)",
        opacity: dim ? 0.35 : l.on ? 1 : 0.55,
      }}
    >
      <button data-editor-layer-toggle onClick={onToggle} data-tip={tipOn} style={{ display: "grid", color: l.on ? "var(--ink-soft)" : "var(--ink-ghost)" }}>
        {l.on ? Icon.dotOn : Icon.dotOff}
      </button>
      {/* 컷은 번호, 말풍선은 종류 아이콘, 나머지는 그림 썸네일 */}
      {l.panel ? (
        <span data-editor-layer-no={no} style={{ width: 18, height: 18, borderRadius: "50%", background: "var(--line)", color: "var(--ink-soft)", fontSize: 10, display: "grid", placeItems: "center", fontVariantNumeric: "tabular-nums", flexShrink: 0 }}>{no}</span>
      ) : l.bubble ? (
        <span style={{ width: 44, height: 30, borderRadius: 3, flexShrink: 0, background: "#fff", display: "grid", placeItems: "center", color: "#111" }}>
          <BubbleKindIcon kind={l.bubble.kind} w={30} h={20} />
        </span>
      ) : (
        <img
          src={thumbOf(l.cv)}
          alt=""
          draggable={false}
          style={{ width: 44, height: 30, borderRadius: 3, flexShrink: 0, background: "conic-gradient(#3a3a44 25%, #2a2a32 0 50%, #3a3a44 0 75%, #2a2a32 0) 0 0/8px 8px" }}
        />
      )}
      {/* 글자 레이어 표식 — 붓이 안 먹는 이유가 목록에서 보인다 */}
      {l.text && <span style={{ display: "grid", color: "var(--ink-faint)", flexShrink: 0 }}>{Icon.typeT12}</span>}
      {/* 컷의 이름은 읽는 차례 번호다 (고칠 이름이 아니다) */}
      {l.panel ? (
        <>
          <span style={{ flex: 1, minWidth: 0, fontSize: "var(--text-2xs)", color: "var(--ink)" }}>
            {tPanel(no)}<small style={{ marginLeft: 6, color: "var(--ink-faint)" }}>{sub}</small>
          </span>
          {/* 넘겨받은 프롬프트가 있는 컷 — 플러그인 모드 색 점 (목업 ⑦) */}
          {l.panel.gen?.handed && <span data-editor-layer-handed style={{ width: 7, height: 7, borderRadius: "50%", background: "var(--mode-plugins)", flexShrink: 0 }} />}
        </>
      ) : (
        <EditableName name={l.name} onRename={onRename} mark="editor-layer" style={{ flex: 1, minWidth: 0, fontSize: "var(--text-2xs)" }} />
      )}
    </div>
  );
}

/** 숫자 칸 — 적고 Enter·밖을 누르면 한 번에 반영 (매 글자마다 이력을 적지 않는다) */
function NumIn({ value, onCommit, min, mark, suffix }: { value: number; onCommit: (v: number) => void; min?: number; mark: string; suffix?: string }) {
  const [text, setText] = useState(String(value));
  const [edit, setEdit] = useState(false);
  useEffect(() => {
    if (!edit) setText(String(value));
  }, [value, edit]);
  const commit = () => {
    setEdit(false);
    const v = Number(text);
    if (!Number.isFinite(v)) return setText(String(value));
    const next = min !== undefined ? Math.max(min, Math.round(v)) : Math.round(v);
    if (next !== value) onCommit(next);
  };
  return (
    <span style={{ position: "relative", display: "inline-flex", alignItems: "center" }}>
      <input
        data-num={mark}
        value={text}
        onFocus={() => setEdit(true)}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur();
          if (e.key === "Escape") { setText(String(value)); setEdit(false); (e.currentTarget as HTMLInputElement).blur(); }
        }}
        style={{ ...box, width: 62, textAlign: "right", fontVariantNumeric: "tabular-nums", padding: "2px 6px", paddingRight: suffix ? 16 : 6 }}
      />
      {suffix && <span style={{ position: "absolute", right: 6, fontSize: "var(--text-3xs)", color: "var(--ink-ghost)", pointerEvents: "none" }}>{suffix}</span>}
    </span>
  );
}

function IconBtn({ children, tip, onClick, disabled, danger, mark }: { children: React.ReactNode; tip: string; onClick: () => void; disabled?: boolean; danger?: boolean; mark: string }) {
  return (
    <button
      data-act={mark}
      onClick={onClick}
      disabled={disabled}
      data-tip={tip}
      style={{ ...box, display: "grid", placeItems: "center", padding: "4px 8px", color: disabled ? "var(--ink-ghost)" : danger ? "var(--err-ink)" : "var(--ink-soft)" }}
    >
      {children}
    </button>
  );
}

/** 만화 페이지의 기둥 칸 — 고른 것에 따라 하나가 선다 (목업 ① · ⑤).
 *  컷: 테두리 없음 · 그림 수. 말풍선: 꼬리(개수 · 추가 · 밑동 폭 · 휨) · 글(여백 · 줄 간격). 그림: 든 컷 (넣기 · 빼기) */
function ComicSections({ doc, sel }: { doc: Doc; sel: Layer }) {
  const t = useI18n((s) => s.t);
  const s = useEditor();
  const nums = panelNumbers(doc.layers, doc.comic!.dir, doc.h);
  const panels = doc.layers.filter((l) => l.panel);

  if (sel.panel) {
    const kids = doc.layers.filter((l) => l.clip === sel.id).length;
    return (
      <Sec label={`${t("editor.panelNo", { n: nums.get(sel.id) ?? "" })} · ${t("editor.panelImages", { n: kids })}`}>
        <Line label={t("editor.border")}>
          <button
            data-editor-panel-noborder
            onMouseDown={dropFocus}
            onClick={() => s.setPanelBorder(sel.id, !sel.panel!.noBorder)}
            style={{ ...box, ...(sel.panel.noBorder ? on : {}), padding: "2px 10px" }}
          >
            {t("editor.noBorder")}
          </button>
        </Line>
        <CutSection doc={doc} panel={sel} />
      </Sec>
    );
  }

  if (sel.bubble) {
    const b = sel.bubble;
    const tails = hasTails(b.kind) ? b.tails : [];
    const first = tails[0];
    const patch = (p: Partial<BubbleMeta>, live = false) => s.patchBubble(sel.id, p, live);
    return (
      <>
        {hasTails(b.kind) && (
          <Sec label={`${t("editor.tails")} · ${t("editor.tailsN", { n: tails.length })}`} help={t("editor.tailsHint")}>
            <div style={{ display: "flex", gap: "var(--sp-2)" }}>
              <button
                data-editor-tail-add
                onMouseDown={dropFocus}
                onClick={() => {
                  // 하나 더 — 있던 꼬리의 반대쪽 (두 사람이 같이 말할 때)
                  const base = defaultTail(b.body, doc.comic!.dir === "rtl" ? (tails.length % 2 ? "rtl" : "ltr") : tails.length % 2 ? "ltr" : "rtl", b.size);
                  patch({ tails: [...b.tails, base] });
                }}
                style={{ ...box, display: "inline-flex", alignItems: "center", gap: 4, padding: "2px 8px" }}
              >
                {Icon.tailAdd}{t("editor.tailAdd")}
              </button>
              {tails.length > 0 && (
                <button data-editor-tail-clear onMouseDown={dropFocus} onClick={() => patch({ tails: [] })} style={{ ...box, padding: "2px 8px" }}>
                  {t("editor.tailClear")}
                </button>
              )}
            </div>
            {first && bendable(b.kind) && (
              <>
                <Line label={t("editor.tailWidth")}>
                  <input
                    type="range"
                    data-editor-tail-width
                    min={4}
                    max={Math.max(60, Math.round(b.size * 2))}
                    value={Math.round(first.w)}
                    onPointerDown={() => s.markBefore()}
                    onChange={(e) => patch({ tails: b.tails.map((q) => ({ ...q, w: Number(e.target.value) })) }, true)}
                    style={{ flex: 1 }}
                  />
                  <span style={num}>{Math.round(first.w)}</span>
                </Line>
                <Line label={t("editor.tailBend")}>
                  <input
                    type="range"
                    data-editor-tail-bend
                    min={-Math.round(b.size * 3)}
                    max={Math.round(b.size * 3)}
                    value={Math.round(first.bend)}
                    onPointerDown={() => s.markBefore()}
                    onChange={(e) => patch({ tails: b.tails.map((q, i) => (i === 0 ? { ...q, bend: Number(e.target.value) } : q)) }, true)}
                    style={{ flex: 1 }}
                  />
                  <span style={num}>{Math.round(first.bend)}</span>
                </Line>
              </>
            )}
          </Sec>
        )}
        <Sec label={t("editor.bubbleText")}>
          <Line label={t("editor.pad")}>
            <input type="range" data-editor-bubble-pad min={0} max={Math.round(b.size * 2)} value={Math.round(b.pad)} onPointerDown={() => s.markBefore()} onChange={(e) => patch({ pad: Number(e.target.value) }, true)} style={{ flex: 1 }} />
            <span style={num}>{Math.round(b.pad)}</span>
          </Line>
          <Line label={t("editor.lineGap")}>
            <input type="range" data-editor-bubble-linegap min={90} max={200} value={Math.round(b.lineGap * 100)} onPointerDown={() => s.markBefore()} onChange={(e) => patch({ lineGap: Number(e.target.value) / 100 }, true)} style={{ flex: 1 }} />
            <span style={num}>{b.lineGap.toFixed(2)}</span>
          </Line>
        </Sec>
      </>
    );
  }

  // 그림 — 어느 컷에 들었나 (넣으면 그 컷을 가득 채우게 놓인다)
  if (!sel.text && !sel.sfx && panels.length) {
    const inside = panels.find((p) => pointInPoly({ x: sel.x + sel.w / 2, y: sel.y + sel.h / 2 }, panelPts(p, p.panel!.pts)));
    const ordered = [...panels].sort((a, b) => (nums.get(a.id) ?? 0) - (nums.get(b.id) ?? 0));
    return (
      <Sec label={t("editor.inPanel")} help={t("editor.inPanelHint")}>
        <select
          data-editor-clip
          value={sel.clip ?? ""}
          onChange={(e) => s.setClip(sel.id, e.target.value || null)}
          style={{ ...box, width: "100%" }}
        >
          <option value="">{t("editor.inPanelNone")}</option>
          {ordered.map((p) => (
            <option key={p.id} value={p.id}>
              {t("editor.panelNo", { n: nums.get(p.id) ?? "" })}{p.id === inside?.id && !sel.clip ? ` · ${t("editor.inPanelHere")}` : ""}
            </option>
          ))}
        </select>
      </Sec>
    );
  }
  return null;
}

/** 페이지 — 용지 크기 · 읽는 방향 · 안내선 (목업 ①의 「페이지」 칸) */
function PageSection({ doc, onExport }: { doc: Doc; onExport: () => void }) {
  const t = useI18n((s) => s.t);
  const s = useEditor();
  const page = doc.comic!;
  const count = s.docs.filter((d) => d.comic).length;
  return (
    <Sec label={`${t("editor.page")}  ${doc.w} × ${doc.h}`}>
      <Line label={t("editor.readDir")}>
        <button data-editor-dir="rtl" onMouseDown={dropFocus} onClick={() => s.setComic({ dir: "rtl" })} style={{ ...box, ...(page.dir === "rtl" ? on : {}), padding: "2px 8px" }}>{t("editor.dirRtl")}</button>
        <button data-editor-dir="ltr" onMouseDown={dropFocus} onClick={() => s.setComic({ dir: "ltr" })} style={{ ...box, ...(page.dir === "ltr" ? on : {}), padding: "2px 8px" }}>{t("editor.dirLtr")}</button>
      </Line>
      <Line label={t("editor.guides")}>
        <button data-editor-guides-toggle onMouseDown={dropFocus} onClick={() => s.setComic({ guides: !page.guides })} style={{ ...box, ...(page.guides ? on : {}), display: "inline-flex", alignItems: "center", gap: 4, padding: "2px 8px" }}>
          {Icon.fitBox}{t(page.guides ? "editor.guidesOn" : "editor.guidesOff")}
        </button>
      </Line>
      <ComicFontStatus />
      {/* 여러 페이지 한 번에 — 만화 페이지 캔버스 전부를 이름 차례로 (설계 11번) */}
      <button data-editor-export-pages onMouseDown={dropFocus} onClick={onExport} style={{ ...box, display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
        {Icon.pages}{t("editor.exportPagesN", { n: count })}
      </button>
    </Sec>
  );
}

/** 만화 글꼴 상태 — 받는 중이면 진행, 못 받았으면 이유와 다시 받기 (다 받았으면 아무것도 안 그린다, 설계 9-3) */
function ComicFontStatus() {
  const t = useI18n((s) => s.t);
  const st = useComicFonts((s) => s.status);
  if (!st || (st.ready && !st.downloading)) return null;
  if (st.downloading) {
    const pct = st.total ? Math.round((st.got / st.total) * 100) : 0;
    return <span data-editor-fonts-state="downloading"><Hint>{t("editor.fontsDownloading", { p: pct })}</Hint></span>;
  }
  if (!st.error) return null;
  return (
    <div data-editor-fonts-state="error" style={{ display: "flex", alignItems: "center", gap: "var(--sp-2)" }}>
      <span data-tip={st.error} style={{ flex: 1, minWidth: 0, fontSize: "var(--text-2xs)", color: "var(--ink-faint)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {t("editor.fontsFailed")}
      </span>
      <button data-editor-fonts-retry onMouseDown={dropFocus} onClick={() => void retryComicFonts()} style={{ ...box, padding: "1px 8px" }}>{t("editor.fontsRetry")}</button>
    </div>
  );
}

/** 컷 생성 칸 — 후보 · 컷 프롬프트 · 인물 · 장 수 · 크게 · 이 컷 생성 · 빈 컷 전부 생성 (설계 8번 · 목업 ⑤).
 *  ★컷 프롬프트는 씬 칸과 **같은 블록 목록**(`BlockList` 의 `single`)이다 — 블록을 그리는 자리는 앱에 하나다.
 *  ★후보는 이 칸의 맨 위다 (사용자 결정 2026-09-23: 무대 위 컷 아래에 띄우면 이웃 컷을 가린다) */
function CutSection({ doc, panel }: { doc: Doc; panel: Layer }) {
  const t = useI18n((s) => s.t);
  const s = useEditor();
  const chars = usePrompt((p) => p.chars);
  const tabName = useWs((w) => w.activeTabOf()?.name ?? "");
  const pending = useQueue((q) => q.pending);
  const [count, setCount] = useState(1);
  const [enhance, setEnhance] = useState(false);
  const [base, setBase] = useState("");
  useEffect(() => {
    void backendUrl().then(setBase);
  }, []);
  const g: PanelGen = { blocks: [], cast: [], takes: [], ...panel.panel!.gen };
  const blk = slotBlock(g.blocks, `cut-${panel.id}`);
  const size = sizeOf(panel);
  const cost = cutCost([panel], count, doc.comic?.addon);
  const cur = doc.layers.find((l) => l.clip === panel.id && l.take)?.take ?? null;
  const group = comicGroupId(doc.id);
  // 빈 컷 — 그림도 없고 대기도 없는 컷 (「빈 컷 전부 생성」이 도는 것)
  const empty = doc.layers.filter(
    (l) => l.panel && l.on && !doc.layers.some((x) => x.clip === l.id) && !pending.some((q) => q.groupId === group && q.cellId === l.id),
  );
  const emptyCost = cutCost(empty, 1, doc.comic?.addon);
  const inpaintCost = cutCost([panel], count, doc.comic?.addon, useImageInput.getState().baseInpaintStrength ?? 1);
  const toggleCast = (id: string) => {
    const has = g.cast.some((c) => c.id === id);
    const next = has ? g.cast.filter((c) => c.id !== id) : [...g.cast, { id, ...castSpot(g.cast.length, g.cast.length + 1) }];
    // 새로 들면 고르게 다시 놓는다 (한 명 → 가운데, 둘 → 좌우) — 이미 끌어 둔 자리는 뺄 때만 그대로
    s.setPanelGen(panel.id, { cast: has ? next : next.map((c, i) => (g.cast.some((x) => x.id === c.id) ? c : { ...c, ...castSpot(i, next.length) })) });
  };
  const costText = (c: { total: number; free: boolean }) => t("editor.cutCost", { a: c.free ? 0 : c.total });
  return (
    <div data-editor-cut style={{ display: "flex", flexDirection: "column", gap: "var(--sp-3)", marginTop: "var(--sp-2)" }}>
      {!g.handed && <span style={{ fontSize: "var(--text-2xs)", color: "var(--ink-faint)" }}>{t("editor.cutUses", { tab: tabName })}</span>}
      {g.takes.length > 0 && base && (
        <div data-editor-cut-takes style={{ display: "flex", flexWrap: "wrap", gap: "var(--sp-2)" }}>
          {g.takes.map((tk) => {
            const on2 = !!cur && cur.ws === tk.ws && cur.file === tk.file;
            return (
              <button
                key={tk.file}
                data-editor-cut-take={tk.file}
                data-on={on2 ? "" : undefined}
                onMouseDown={dropFocus}
                onClick={() => void pickTake(doc.id, panel.id, tk)}
                style={{ width: 58, height: 44, padding: 0, borderRadius: "var(--r-1)", overflow: "hidden", border: on2 ? "2px solid var(--accent)" : "1px solid var(--line)", background: "var(--bg)" }}
              >
                <img src={thumbUrlOf(base, tk.ws, tk.file)} alt="" draggable={false} style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
              </button>
            );
          })}
        </div>
      )}
      {/* ★플러그인이 넘겨준 컷은 기본의 「컷 프롬프트 · 인물」 자리에 넘겨받은 프롬프트 칸이 선다 (설계 10-1 · 목업 ⑦) */}
      {g.handed && <HandedSection doc={doc} panel={panel} />}
      {!g.handed && (
      <div data-editor-cut-prompt>
        <BlockList single fill id={`cut-${panel.id}`} blocks={[blk]} onChange={(b) => s.setPanelGen(panel.id, { blocks: slotBlocksOf(b[0] ?? blk) })} libZone={`cut-${panel.id}`} />
      </div>
      )}
      {!g.handed && (
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-2)" }}>
        <span style={{ fontSize: "var(--text-2xs)", color: "var(--ink-faint)" }}>{t("editor.cutCast")}</span>
        {!chars.length && <Hint>{t("editor.cutNoChars")}</Hint>}
        <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--sp-2)" }}>
          {chars.map((ch, i) => {
            const at = g.cast.findIndex((c) => c.id === ch.id);
            return (
              <button
                key={ch.id}
                data-editor-cut-cast={ch.id}
                data-on={at >= 0 ? "" : undefined}
                onMouseDown={dropFocus}
                onClick={() => toggleCast(ch.id)}
                style={{ ...box, ...(at >= 0 ? on : {}), display: "inline-flex", alignItems: "center", gap: 6, padding: "2px 10px 2px 6px" }}
              >
                <span style={{ width: 12, height: 12, borderRadius: "50%", background: at >= 0 ? CAST_COLORS[i % CAST_COLORS.length] : "var(--line)", flexShrink: 0 }} />
                {ch.name || `#${i + 1}`}
              </button>
            );
          })}
        </div>
      </div>
      )}
      <Line label={t("editor.cutCount")}>
        <span style={{ display: "inline-flex", gap: 2 }}>
          {[1, 2, 3, 4].map((n) => (
            <button key={n} data-editor-cut-count={n} onMouseDown={dropFocus} onClick={() => setCount(n)} style={{ ...box, ...(count === n ? on : {}), padding: "2px 9px" }}>{n}</button>
          ))}
        </span>
        <span style={{ flex: 1 }} />
        <button data-editor-cut-big data-tip={t("editor.cutBigHint")} onMouseDown={dropFocus} onClick={() => s.setPanelGen(panel.id, { big: !g.big })} style={{ ...box, ...(g.big ? on : {}), padding: "2px 8px" }}>
          {t("editor.cutBig")}
        </button>
      </Line>
      <button
        data-editor-cut-gen
        disabled={cost.overLimit}
        onClick={() => void generateCuts(doc, [panel.id], count)}
        style={{ width: "100%", padding: "var(--sp-2) 0", borderRadius: "var(--r-2)", border: "1px solid var(--accent)", background: "var(--accent)", color: "#fff", fontSize: "var(--text-xs)", fontWeight: "var(--w-semi)", opacity: cost.overLimit ? 0.5 : 1 }}
      >
        {t("editor.cutGen")}
        <small style={{ fontWeight: "var(--w-normal)", opacity: 0.85, marginLeft: 6 }}>{size.w} × {size.h} · {costText(cost)}</small>
      </button>
      {cost.overLimit && <Hint>{t("editor.cutOver")}</Hint>}
      {/* 이 컷만 다시 — 지금 보이는 것을 베이스로 컷 모양 안만 다시 그리기(인페인트) · 든 그림을 큰 판으로 다시 그리기(강화). 결과는 이 컷의 후보로 */}
      <div style={{ display: "flex", gap: "var(--sp-2)" }}>
        <button
          data-editor-cut-inpaint
          disabled={inpaintCost.overLimit}
          onMouseDown={dropFocus}
          onClick={() => void inpaintCuts(doc, [panel.id], count)}
          data-tip={t("editor.cutInpaintHint")}
          style={{ ...box, flex: 1, display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6, padding: "var(--sp-2) 0" }}
        >
          {Icon.brush}{t("editor.cutInpaint")}
          <small style={{ color: "var(--ink-faint)" }}>{costText(inpaintCost)}</small>
        </button>
        <button
          data-editor-cut-enhance
          disabled={!cur}
          onMouseDown={dropFocus}
          onClick={() => setEnhance(true)}
          data-tip={t(cur ? "editor.cutEnhanceHint" : "editor.cutEnhanceNone")}
          style={{ ...box, flex: 1, display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6, padding: "var(--sp-2) 0", color: cur ? undefined : "var(--ink-ghost)" }}
        >
          {Icon.spark}{t("enhance.button")}
        </button>
      </div>
      {enhance && cur && <EnhanceDialog files={[cur.file]} ws={cur.ws} route={cutRoute(doc, panel)} onClose={() => setEnhance(false)} />}
      <button
        data-editor-cut-gen-empty
        disabled={!empty.length || emptyCost.overLimit}
        onClick={() => void generateCuts(doc, empty.map((l) => l.id), 1)}
        style={{ ...box, width: "100%", display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6, padding: "var(--sp-2) 0" }}
      >
        {t("editor.cutGenEmpty")}
        <span style={{ minWidth: 16, height: 16, padding: "0 4px", borderRadius: 8, background: "var(--line)", fontSize: 10, display: "grid", placeItems: "center" }}>{empty.length}</span>
        {empty.length > 0 && <small style={{ color: "var(--ink-faint)" }}>{costText(emptyCost)}</small>}
      </button>
    </div>
  );
}
