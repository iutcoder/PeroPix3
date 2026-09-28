import { useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n";
import { Icon } from "../components/Icon";
import { Line, box, dropFocus, on } from "../panels/censor/ui";
import { sizePreview, withRatio, type Anchor, type Fill, type Size } from "./model";
import { LAYOUTS, pageLabel, paperPx, type Dir, type Dpi, type PaperId } from "./comic";
import { LayoutThumb } from "./comicUi";
import { composite, exportDataUrl } from "./pixels";
import { api } from "../lib/backend";
import { toast } from "../store/toast";
import { useUi } from "../store/ui";
import { pageView, useEditor, type Doc } from "./store";

/** 캔버스 크기 — 목업 ③ 그대로 (사용자 지적 2026-09-22: 생김새가 목업과 많이 달랐다).
 *  왼쪽에 폭·높이(지금 값이 오른쪽에 흐리게) · 빈 자리 · 기준점(3×3 화살표), 오른쪽에 미리보기.
 *  기준점 쪽은 붙어 있고 반대쪽이 늘거나 준다. 넓힌 자리는 「빈 자리」대로 — 투명이면 비워 두고(인페인트로 보낸다),
 *  색이면 그 자리만 칠한 레이어를 맨 아래에 깐다 (`setCanvasSize`). */
export function CanvasSizeDialog({ doc, onClose }: { doc: Doc; onClose: () => void }) {
  const t = useI18n((s) => s.t);
  const [w, setW] = useState(doc.w);
  const [h, setH] = useState(doc.h);
  const [a, setA] = useState<Anchor>({ ax: 0.5, ay: 0.5 });
  const [fill, setFill] = useState<Fill>("transparent");
  /** 비율 유지 (사용자 지시 2026-09-22) — 이미지 크기 창과 같은 단추. ★기본은 꺼짐: 캔버스는 한쪽만 늘리는 일이 잦다 (이미지 크기는 켜짐) */
  const [lock, setLock] = useState(false);
  const ok = () => {
    if (w >= 1 && h >= 1) useEditor.getState().setCanvasSize(Math.round(w), Math.round(h), a, fill);
    onClose();
  };
  return (
    <Modal title={t("editor.canvasSizeTitle")} onOk={ok} onClose={onClose} mark="editor-canvas-dialog" width={460}>
      <div style={{ display: "flex", gap: "var(--sp-6)" }}>
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: "var(--sp-2)" }}>
          <Line label={t("editor.width")}>
            <NumField mark="editor-dlg-w" value={w} onChange={(v) => { setW(v); if (lock) setH(withRatio(doc.w, doc.h, v)); }} />
            <span style={unit}>px</span>
            <span data-editor-dlg-was-w style={was}>{doc.w}</span>
          </Line>
          <Line label={t("editor.height")}>
            <NumField mark="editor-dlg-h" value={h} onChange={(v) => { setH(v); if (lock) setW(withRatio(doc.h, doc.w, v)); }} />
            <span style={unit}>px</span>
            <span data-editor-dlg-was-h style={was}>{doc.h}</span>
          </Line>
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <button data-editor-dlg-lock onMouseDown={dropFocus} onClick={() => setLock(!lock)} style={{ ...box, ...(lock ? on : {}), padding: "2px 8px" }}>
              {t("editor.ratio")}
            </button>
          </div>
          <Line label={t("editor.fill")}>
            <select data-editor-fill value={fill} onChange={(e) => setFill(e.target.value as Fill)} style={{ ...box, flex: 1, minWidth: 0 }}>
              <option value="transparent">{t("editor.fillNone")}</option>
              <option value="white">{t("editor.fillWhite")}</option>
              <option value="black">{t("editor.fillBlack")}</option>
            </select>
          </Line>
          <Line label={t("editor.anchor")} help={t("editor.anchorHint")}>
            <AnchorGrid a={a} setA={setA} />
          </Line>
        </div>
        <SizePreview doc={doc} to={{ w, h }} a={a} />
      </div>
    </Modal>
  );
}

const unit: React.CSSProperties = { fontSize: "var(--text-2xs)", color: "var(--ink-faint)" };
/** 지금 값 — 줄 오른쪽 끝에 흐리게 */
const was: React.CSSProperties = { marginLeft: "auto", fontSize: "var(--text-2xs)", color: "var(--ink-ghost)", fontVariantNumeric: "tabular-nums" };

const AXES = [0, 0.5, 1] as const;

/** 기준점 3×3 — 고른 칸은 점, 나머지 칸은 **고른 칸에서 그쪽으로** 향하는 화살표 (그쪽으로 늘거나 준다는 뜻) */
function AnchorGrid({ a, setA }: { a: Anchor; setA: (a: Anchor) => void }) {
  return (
    <div data-editor-anchors style={{ display: "grid", gridTemplateColumns: "repeat(3, 26px)", gap: 3 }}>
      {AXES.map((ay) =>
        AXES.map((ax) => {
          const me = a.ax === ax && a.ay === ay;
          const deg = me ? 0 : (Math.atan2(ay - a.ay, ax - a.ax) * 180) / Math.PI + 90;
          return (
            <button
              key={`${ax}-${ay}`}
              data-editor-anchor={`${ax},${ay}`}
              onMouseDown={dropFocus}
              onClick={() => setA({ ax, ay })}
              style={{ ...box, ...(me ? on : {}), width: 26, height: 26, padding: 0, display: "grid", placeItems: "center", color: me ? "var(--accent-ink)" : "var(--ink-ghost)" }}
            >
              {me
                ? <span style={{ width: 5, height: 5, borderRadius: "50%", background: "currentColor" }} />
                : <span style={{ display: "grid", transform: `rotate(${deg}deg)` }}>{Icon.arrowUp12}</span>}
            </button>
          );
        }),
      )}
    </div>
  );
}

const PREV: Size = { w: 210, h: 118 };
const CHECKER = "conic-gradient(#2a2a32 25%, #222229 0 50%, #2a2a32 0 75%, #222229 0) 0 0/10px 10px";

/** 미리보기 — 새 캔버스(점선·체커) 위에 지금 캔버스(합성 그림)를 기준점대로 놓아 보인다. 오른쪽 위는 늘거나 주는 양 */
function SizePreview({ doc, to, a }: { doc: Doc; to: Size; a: Anchor }) {
  const p = sizePreview(doc, to, a, PREV);
  const cvRef = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const cv = cvRef.current;
    if (cv) composite(doc, cv, p.k * Math.min(2, window.devicePixelRatio || 1));
  }, [doc, p.k]);
  const delta = (n: number) => (n > 0 ? `+${n}` : `${n}`);
  return (
    <div
      data-editor-size-preview
      style={{ position: "relative", width: PREV.w, height: PREV.h, flexShrink: 0, border: "1px solid var(--line)", borderRadius: 3, background: "var(--bg)", overflow: "hidden" }}
    >
      <div style={{ position: "absolute", left: p.next.x, top: p.next.y, width: p.next.w, height: p.next.h, boxSizing: "border-box", border: "1px dashed var(--ink-ghost)", background: CHECKER }} />
      <canvas ref={cvRef} style={{ position: "absolute", left: p.cur.x, top: p.cur.y, width: p.cur.w, height: p.cur.h, outline: "1px solid var(--accent-ink)" }} />
      <span data-editor-size-delta style={{ position: "absolute", right: 6, top: 4, fontSize: 10, color: "var(--ink-faint)", fontVariantNumeric: "tabular-nums" }}>
        {delta(to.w - doc.w)} × {delta(to.h - doc.h)}
      </span>
    </div>
  );
}

/** 이미지 크기 — 문서와 레이어 전부를 같은 비로 (원본 픽셀은 그대로 두고 변형만 바꾼다) */
export function ImageSizeDialog({ doc, onClose }: { doc: Doc; onClose: () => void }) {
  const t = useI18n((s) => s.t);
  const [w, setW] = useState(doc.w);
  const [h, setH] = useState(doc.h);
  const [lock, setLock] = useState(true);
  const ok = () => {
    if (w >= 1 && h >= 1) useEditor.getState().setImageSize(Math.round(w), Math.round(h));
    onClose();
  };
  return (
    <Modal title={t("editor.imageSizeTitle")} onOk={ok} onClose={onClose} mark="editor-image-dialog">
      <Line label={t("editor.dims")}>
        <NumField mark="editor-dlg-w" value={w} onChange={(v) => { setW(v); if (lock) setH(withRatio(doc.w, doc.h, v)); }} />
        <span style={{ color: "var(--ink-ghost)" }}>×</span>
        <NumField mark="editor-dlg-h" value={h} onChange={(v) => { setH(v); if (lock) setW(withRatio(doc.h, doc.w, v)); }} />
        <button data-editor-dlg-lock onMouseDown={dropFocus} onClick={() => setLock(!lock)} style={{ ...box, ...(lock ? on : {}), padding: "2px 8px", marginLeft: "auto" }}>
          {t("editor.ratio")}
        </button>
      </Line>
      <span style={{ fontSize: "var(--text-2xs)", color: "var(--ink-faint)" }}>{t("editor.imageSizeHint")}</span>
    </Modal>
  );
}

function NumField({ mark, value, onChange }: { mark: string; value: number; onChange: (v: number) => void }) {
  return (
    <input
      data-num={mark}
      type="number"
      min={1}
      value={value}
      onChange={(e) => onChange(Math.max(1, Math.round(Number(e.target.value) || 1)))}
      style={{ ...box, width: 72, textAlign: "right", fontVariantNumeric: "tabular-nums" }}
    />
  );
}

/** 작은 창 — 확인 창(`AskDialog`)과 같은 뼈대. Esc 취소 · Enter 적용 */
function Modal({ title, children, onOk, onClose, mark, width = 380, okLabel }: { title: string; children: React.ReactNode; onOk: () => void; onClose: () => void; mark: string; width?: number; okLabel?: string }) {
  const t = useI18n((s) => s.t);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); onClose(); }
      if (e.key === "Enter") { e.stopPropagation(); onOk(); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onOk, onClose]);
  return (
    <div
      data-modal={mark}
      onPointerDown={(e) => e.target === e.currentTarget && onClose()}
      style={{ position: "fixed", inset: 0, zIndex: 90, background: "rgba(6,8,12,0.62)", display: "grid", placeItems: "center", padding: "var(--sp-6)" }}
    >
      <div style={{ background: "var(--bg)", border: "1px solid var(--line)", borderRadius: "var(--r-4)", padding: "var(--sp-5)", width: `min(${width}px, 92vw)`, display: "flex", flexDirection: "column", gap: "var(--sp-4)" }}>
        <b style={{ fontSize: "var(--text-md)" }}>{title}</b>
        {children}
        <div style={{ display: "flex", gap: "var(--sp-2)", justifyContent: "flex-end" }}>
          <button data-modal-cancel onClick={onClose} style={btn}>{t("common.cancel")}</button>
          <button data-modal-ok onClick={onOk} style={{ ...btn, background: "var(--accent)", borderColor: "var(--accent)", color: "#fff" }}>{okLabel ?? t("editor.apply")}</button>
        </div>
      </div>
    </div>
  );
}

const btn: React.CSSProperties = {
  border: "1px solid var(--line)",
  borderRadius: "var(--r-2)",
  background: "var(--panel)",
  color: "var(--ink-soft)",
  padding: "var(--sp-2) var(--sp-5)",
  fontSize: "var(--text-xs)",
};

/** 새 캔버스 — 목업 ② (사용자 확정 2026-09-23). 이미지 / 만화 페이지를 먼저 고르고, 만화 페이지면 판형 · 해상도 · 읽는 방향 · 첫 배치.
 *  ★만화 페이지가 새 모드가 아니라 **캔버스의 한 종류**다 (설계 2번) — 그래서 「새 캔버스」가 이 둘로 갈린다 */
export function NewCanvasDialog({ onClose }: { onClose: () => void }) {
  const t = useI18n((s) => s.t);
  const [kind, setKind] = useState<"image" | "comic">("comic");
  const [iw, setIw] = useState(1216);
  const [ih, setIh] = useState(832);
  const [paper, setPaper] = useState<PaperId>("a4");
  const [dpi, setDpi] = useState<Dpi>(200);
  const [cw, setCw] = useState(1654);
  const [ch, setCh] = useState(2339);
  const [dir, setDir] = useState<Dir>("rtl");
  const [layout, setLayout] = useState("hero-top");
  const size = paper === "custom" ? { w: cw, h: ch } : paperPx(paper, dpi);
  const ok = () => {
    const st = useEditor.getState();
    if (kind === "image") st.newDoc({ w: Math.max(1, iw), h: Math.max(1, ih) });
    else st.newDoc({ w: Math.max(64, size.w), h: Math.max(64, size.h), comic: { dir, layout } });
    onClose();
  };
  const card = (on2: boolean): React.CSSProperties => ({
    ...box, ...(on2 ? on : {}), flex: 1, display: "flex", alignItems: "center", gap: "var(--sp-3)", padding: "var(--sp-3) var(--sp-4)", textAlign: "left", borderRadius: "var(--r-3)",
  });
  const sub: React.CSSProperties = { display: "block", fontSize: "var(--text-3xs)", color: "var(--ink-faint)", marginTop: 1 };
  const seg = (active: boolean): React.CSSProperties => ({ ...box, ...(active ? on : {}), padding: "3px 10px", whiteSpace: "nowrap" });
  return (
    <Modal title={t("editor.newDoc")} onOk={ok} onClose={onClose} mark="editor-new-dialog" width={kind === "comic" ? 580 : 420} okLabel={t("editor.create")}>
      <div style={{ display: "flex", gap: "var(--sp-3)" }}>
        <button data-editor-new-kind="image" onMouseDown={dropFocus} onClick={() => setKind("image")} style={card(kind === "image")}>
          {Icon.image}
          <span>{t("editor.kindImage")}<small style={sub}>1216 × 832</small></span>
        </button>
        <button data-editor-new-kind="comic" onMouseDown={dropFocus} onClick={() => setKind("comic")} style={card(kind === "comic")}>
          {Icon.page}
          <span>{t("editor.kindComic")}<small style={sub}>{t("editor.kindComicSub")}</small></span>
        </button>
      </div>
      {kind === "image" && (
        <Line label={t("editor.dims")}>
          <NumField mark="editor-new-w" value={iw} onChange={setIw} />
          <span style={{ color: "var(--ink-ghost)" }}>×</span>
          <NumField mark="editor-new-h" value={ih} onChange={setIh} />
        </Line>
      )}
      {kind === "comic" && (
        <div style={{ display: "flex", gap: "var(--sp-5)", alignItems: "flex-start" }}>
          <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: "var(--sp-3)" }}>
            <Line label={t("editor.paperSize")}>
              <select data-editor-new-paper value={paper} onChange={(e) => setPaper(e.target.value as PaperId)} style={{ ...box, flex: 1, minWidth: 0 }}>
                <option value="a4">A4 (210 × 297 mm)</option>
                <option value="b5">B5 (182 × 257 mm)</option>
                <option value="b4">B4 (257 × 364 mm)</option>
                <option value="web">{t("editor.paperWeb")}</option>
                <option value="custom">{t("editor.paperCustom")}</option>
              </select>
            </Line>
            {paper !== "custom" && paper !== "web" && (
              <Line label={t("editor.resolution")} help={t("editor.resolutionHint")}>
                {([200, 300] as const).map((d) => {
                  const p = paperPx(paper, d);
                  return (
                    <button key={d} data-editor-new-dpi={d} onMouseDown={dropFocus} onClick={() => setDpi(d)} style={seg(dpi === d)}>
                      {t(d === 200 ? "editor.dpiNormal" : "editor.dpiPrint")} {p.w} × {p.h}
                    </button>
                  );
                })}
              </Line>
            )}
            {paper === "web" && <Line label={t("editor.resolution")}><span style={{ fontSize: "var(--text-2xs)", color: "var(--ink-soft)" }}>{size.w} × {size.h}</span></Line>}
            {paper === "custom" && (
              <Line label={t("editor.dims")}>
                <NumField mark="editor-new-cw" value={cw} onChange={setCw} />
                <span style={{ color: "var(--ink-ghost)" }}>×</span>
                <NumField mark="editor-new-ch" value={ch} onChange={setCh} />
              </Line>
            )}
            <Line label={t("editor.readDir")}>
              <button data-editor-new-dir="rtl" onMouseDown={dropFocus} onClick={() => setDir("rtl")} style={seg(dir === "rtl")}>{t("editor.dirRtl")}</button>
              <button data-editor-new-dir="ltr" onMouseDown={dropFocus} onClick={() => setDir("ltr")} style={seg(dir === "ltr")}>{t("editor.dirLtr")}</button>
            </Line>
            <div style={{ display: "flex", gap: "var(--sp-2)" }}>
              <span style={{ width: 52, flexShrink: 0, fontSize: "var(--text-2xs)", color: "var(--ink-faint)", paddingTop: 4 }}>{t("editor.firstLayout")}</span>
              <div data-editor-new-layouts style={{ display: "grid", gridTemplateColumns: "repeat(6, 38px)", gap: 6 }}>
                {Object.keys(LAYOUTS).map((k) => (
                  <button
                    key={k}
                    data-editor-new-layout={k}
                    onMouseDown={dropFocus}
                    onClick={() => setLayout(k)}
                    style={{ ...box, ...(layout === k ? on : {}), width: 38, height: 52, padding: 0, display: "grid", placeItems: "center" }}
                  >
                    <LayoutThumb layout={k} w={28} h={40} />
                  </button>
                ))}
              </div>
            </div>
          </div>
          <div style={{ flexShrink: 0, borderRadius: 3, overflow: "hidden", boxShadow: "0 0 0 1px var(--line)" }}>
            <LayoutThumb layout={layout} w={118} h={Math.round((118 * size.h) / Math.max(1, size.w))} />
          </div>
        </div>
      )}
    </Modal>
  );
}

/** 만화 캔버스의 페이지 여러 장을 **한 번에** 내보낸다 (설계 11번) — 페이지 차례로 `<이름>_01.png` …, ZIP 하나, PDF 하나.
 *  ★저장 폴더는 한 장 저장의 「저장 폴더 지정」과 같은 값(`useUi.editLast.dest`)을 쓴다. 메타데이터는 한 장 저장과 같이 민다 */
export function ExportPagesDialog({ doc, onClose }: { doc: Doc; onClose: () => void }) {
  const t = useI18n((s) => s.t);
  const pages = doc.comic?.pages ?? [];
  const [pick, setPick] = useState<string[]>(() => [...pages]);
  const [fmt, setFmt] = useState<"png" | "webp" | "zip" | "pdf">("png");
  const [name, setName] = useState(() => doc.name);
  const dest = useUi((s) => s.editLast.dest);
  const setEditLast = useUi((s) => s.setEditLast);
  const [busy, setBusy] = useState(false);
  const chosen = pages.filter((p) => pick.includes(p));
  const pickDir = async () => {
    try {
      const r = await api<{ dir: string | null }>("/api/files/pick-dir", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ start: dest }) });
      if (r.dir) setEditLast({ dest: r.dir });
    } catch (e) {
      toast(String(e), "warn");
    }
  };
  const run = async () => {
    if (busy || !chosen.length) return;
    if (!dest) return toast(t("editor.needDest"), "warn");
    setBusy(true);
    try {
      const images = chosen.map((p) => exportDataUrl(pageView(doc, p)));
      const r = await api<{ files: string[]; dir: string }>("/api/edit/export-pages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ images, base: name.trim() || "page", fmt, dest }),
      });
      toast(t("editor.exportDone", { n: chosen.length, dir: r.dir }));
      onClose();
    } catch (e) {
      toast(t("editor.saveFail", { e: String(e) }), "warn");
    } finally {
      setBusy(false);
    }
  };
  const ext = fmt === "zip" ? ".zip" : fmt === "pdf" ? ".pdf" : `_${"1".padStart(Math.max(2, String(chosen.length).length), "0")}.${fmt}`;
  return (
    <Modal title={t("editor.exportPages")} mark="editor-export-pages" onOk={() => void run()} onClose={onClose} okLabel={busy ? t("editor.exporting") : t("editor.export")} width={420}>
      <div data-export-pages-list style={{ display: "flex", flexDirection: "column", gap: 2, maxHeight: 200, overflowY: "auto", border: "1px solid var(--line)", borderRadius: "var(--r-2)", padding: 4, background: "var(--panel)" }}>
        {pages.map((p, i) => {
          const onIt = pick.includes(p);
          return (
            <label key={p} data-export-page={i + 1} style={{ display: "flex", alignItems: "center", gap: 8, padding: "3px 6px", fontSize: "var(--text-xs)", color: onIt ? "var(--ink)" : "var(--ink-faint)", cursor: "pointer" }}>
              <input type="checkbox" checked={onIt} onChange={() => setPick(onIt ? pick.filter((x) => x !== p) : [...pick, p])} />
              <span style={{ flex: 1, minWidth: 0, fontVariantNumeric: "tabular-nums" }}>{pageLabel(i)}</span>
              <span style={{ color: "var(--ink-ghost)", fontSize: "var(--text-3xs)" }}>{doc.w} × {doc.h}</span>
            </label>
          );
        })}
      </div>
      <Line label={t("editor.exportName")}>
        <input data-export-name value={name} onChange={(e) => setName(e.target.value)} style={{ ...box, flex: 1, padding: "3px 6px" }} />
      </Line>
      <Line label={t("tools.format")}>
        {(["png", "webp", "zip", "pdf"] as const).map((f) => (
          <button key={f} data-export-fmt={f} onMouseDown={dropFocus} onClick={() => setFmt(f)} style={{ ...box, ...(fmt === f ? on : {}), padding: "2px 10px" }}>{f.toUpperCase()}</button>
        ))}
      </Line>
      <Line label={t("tools.dest")}>
        <button data-export-dest onClick={() => void pickDir()} style={{ ...box, flex: 1, minWidth: 0, textAlign: "left", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", direction: dest ? "rtl" : undefined }}>
          {dest || t("tools.destPick")}
        </button>
      </Line>
      <span data-export-preview style={{ fontSize: "var(--text-2xs)", color: "var(--ink-faint)" }}>{t("tools.preview", { s: `${name.trim() || "page"}${ext}` })} · {t("editor.exportCount", { n: chosen.length })}</span>
    </Modal>
  );
}
