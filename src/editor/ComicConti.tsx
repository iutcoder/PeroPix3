import { useEffect, useState } from "react";
import { useI18n } from "../i18n";
import { Icon } from "../components/Icon";
import { box, dropFocus } from "../panels/censor/ui";
import { useCli } from "../store/cli";
import { useLlm } from "../store/llm";
import { toast } from "../store/toast";
import { useUi } from "../store/ui";
import { genOf, pageLabel, pageLayers } from "./comic";
import { useEditor, type Doc } from "./store";

/** 「AI 콘티」 — 무대 머리의 버튼 하나와 그 창 (설계 10번 · 목업 v2 ④ ⑤).
 *
 *  ★AI 를 부르는 버튼은 **이것 하나**다. 컷 하나만 AI 로 채우는 버튼은 두지 않는다 (사용자 지시 2026-09-28).
 *  ★「콘티 짜기」 → **AI 조수의 새 대화**가 열리고, 창에서 고른 것이 첫 메시지로 들어간다. 조수가 같은 캔버스의
 *    마지막 페이지 뒤에 페이지를 하나씩 깐다 (`read_comic` → `add_comic_page`, 실행은 `comicAgent`).
 *  ★★콘티를 만드는 동안 버튼이 잠긴다 (사용자 지시 2026-09-28) — 그 대화가 턴을 마치면 풀린다 (`watch`).
 *  ★AI 조수를 설정하지 않았으면 버튼이 꺼지고 이유가 툴팁으로 뜬다 */
export function ContiButton({ doc }: { doc: Doc }) {
  const t = useI18n((s) => s.t);
  const busy = useEditor((s) => s.contiBusy);
  const engine = useCli((s) => s.engine);
  const exe = useCli((s) => s.exe);
  const cfg = useLlm((s) => s.cfg);
  const [open, setOpen] = useState(false);
  // 준비 상태를 알려면 설정과 CLI 탐지가 한 번은 돌아 있어야 한다 (AI 패널을 한 번도 안 열었을 수 있다)
  useEffect(() => {
    if (!useLlm.getState().cfg) void useLlm.getState().loadConfig();
    const c = useCli.getState();
    if (c.engine === "cli" && !c.items.length && !c.scanning) void c.detect();
  }, []);
  const ready = engine === "cli" ? !!exe : !!cfg?.hasKey;
  const locked = !!busy;
  const why = locked ? t("editor.contiBusyTip") : !ready ? t("editor.contiNotReady") : undefined;
  return (
    <>
      {/* ★꺼진 버튼은 툴팁이 흐려지므로 감싼 칸이 툴팁을 든다 */}
      <span data-tip={why} style={{ display: "inline-flex" }}>
        <button
          data-editor-conti
          data-busy={locked ? "" : undefined}
          disabled={locked || !ready}
          onMouseDown={dropFocus}
          onClick={() => setOpen(true)}
          style={{
            display: "inline-flex", alignItems: "center", gap: 5, height: 24, padding: "0 10px", borderRadius: "var(--r-2)", whiteSpace: "nowrap",
            border: "1px solid rgba(142,192,233,.35)", color: "var(--accent-ink)", background: "rgba(58,123,184,.10)",
            fontSize: "var(--text-2xs)", fontWeight: "var(--w-semi)", opacity: locked || !ready ? 0.5 : 1,
          }}
        >
          {locked
            ? <span className="busy-spin" style={{ width: 10, height: 10, borderRadius: "50%", border: "2px solid rgba(142,192,233,.28)", borderTopColor: "var(--accent-ink)" }} />
            : Icon.spark}
          {t("editor.conti")}
        </button>
      </span>
      {open && <ContiDialog doc={doc} onClose={() => setOpen(false)} />}
    </>
  );
}

/** 창에서 고른 것 — 다음에 열 때 그대로 (앱을 켜 둔 동안) */
type Opts = { pages: number; maxCuts: number; layout: "free" | "template"; lang: "ko" | "ja" | "en"; place: "editor" | "nai" | "none" };
let lastOpts: Opts = { pages: 0, maxCuts: 6, layout: "free", lang: "ko", place: "editor" };
let lastText = "";

/** 그린 페이지가 있나 — 없으면 칸 이름이 「이번에 그릴 내용」이고 첫 페이지부터 깐다 (설계 10-1) */
function drawn(doc: Doc): boolean {
  const c = doc.comic!;
  return c.pages.some((pid) =>
    pageLayers(doc.layers, c.pages, pid).some((l, i) => {
      if (l.panel) {
        const g = genOf(l.panel);
        return !!(g.summary || g.blocks.length || g.cast.length || g.bg || g.takes.length) || doc.layers.some((k) => k.clip === l.id);
      }
      return i > 0;
    }),
  );
}

function ContiDialog({ doc, onClose }: { doc: Doc; onClose: () => void }) {
  const t = useI18n((s) => s.t);
  const [text, setText] = useState(lastText);
  const [o, setO] = useState<Opts>(lastOpts);
  const engine = useCli((s) => s.engine);
  const cli = useCli((s) => s.items.find((x) => x.id === s.agent));
  const cliModel = useCli((s) => s.model);
  const cfg = useLlm((s) => s.cfg);
  const c = doc.comic!;
  const has = drawn(doc);
  const lastLabel = pageLabel(c.pages.length - 1);
  const where = has ? t("editor.contiWhereAfter", { p: lastLabel }) : t("editor.contiWhereFirst");
  const cast = c.common.chars.map((ch, i) => ch.name || t("cards.charN", { n: i + 1 }));
  const bgs = c.common.bgs.map((b) => b.label);
  const engineLabel = engine === "cli"
    ? [cli?.label, cliModel].filter(Boolean).join(" · ")
    : [cfg?.providers.find((p) => p.id === cfg.provider)?.label, cfg?.model].filter(Boolean).join(" · ");
  const set = (p: Partial<Opts>) => setO((x) => ({ ...x, ...p }));
  const dirLabel = t(c.dir === "rtl" ? "editor.dirRtl" : "editor.dirLtr");
  const LANG = { ko: t("editor.contiLangKo"), ja: t("editor.contiLangJa"), en: t("editor.contiLangEn") } as const;
  const PLACE = { editor: t("editor.contiPlaceEditor"), nai: t("editor.contiPlaceNai"), none: t("editor.contiPlaceNone") } as const;

  const go = async () => {
    const body = text.trim();
    if (!body) return;
    const llm = useLlm.getState();
    // ★다른 대화가 도는 중이면 새 대화를 못 연다 — 도는 응답이 새 대화에 붙는다 (`llm.newChat` 의 ★주)
    if (llm.sending) { toast(t("editor.contiOtherBusy"), "warn"); return; }
    lastOpts = o;
    lastText = "";
    const none = t("editor.contiNone");
    // ★첫 메시지 — 사람이 읽는 글이다 (대화에 그대로 남는다). 규칙은 `read_comic` 의 안내가 싣는다
    const msg = [
      `${t("editor.conti")}: ${body}`,
      "",
      `${t("editor.contiWhere")}: 「${doc.name}」 ${where}`,
      `${t("editor.contiPages")}: ${o.pages ? o.pages : t("editor.contiAuto")} · ${t("editor.contiMaxCuts")}: ${o.maxCuts ? o.maxCuts : t("editor.contiAuto")}`,
      `${t("editor.contiLayout")}: ${o.layout === "free" ? t("editor.contiFree") : t("editor.contiTemplate")} · ${t("editor.readDir")}: ${dirLabel}`,
      `${t("editor.contiLang")}: ${o.place === "none" ? PLACE.none : `${LANG[o.lang]} · ${PLACE[o.place]}`}`,
      `${t("editor.contiCast")}: ${cast.join(" · ") || none}`,
      `${t("editor.contiBgs")}: ${bgs.join(" · ") || none}`,
      "",
      t("editor.contiAsk"),
    ].join("\n");
    onClose();
    useUi.getState().openAi();
    llm.newChat();
    watch(doc.id);
    await useLlm.getState().send(msg);
    // ★턴이 이미 끝났으면(오류 · 즉시 끝남) 여기서 푼다. 아직 돌면 `watch` 가 끝날 때 푼다
    if (!useLlm.getState().sending) release();
  };

  const row = (label: string, child: React.ReactNode, top = false) => (
    <div style={{ display: "flex", gap: "var(--sp-4)", alignItems: top ? "flex-start" : "center" }}>
      <span style={{ width: 96, flexShrink: 0, fontSize: "var(--text-2xs)", color: "var(--ink-faint)", paddingTop: top ? 6 : 0 }}>{label}</span>
      <div style={{ flex: 1, minWidth: 0 }}>{child}</div>
    </div>
  );
  const sel = <K extends keyof Opts>(k: K, opts: [Opts[K], string][]) => (
    <select data-conti-opt={k} value={String(o[k])} onChange={(e) => set({ [k]: (typeof o[k] === "number" ? Number(e.target.value) : e.target.value) } as Partial<Opts>)} style={{ ...box, width: "100%", padding: "4px 8px" }}>
      {opts.map(([v, l]) => <option key={String(v)} value={String(v)}>{l}</option>)}
    </select>
  );
  const auto = t("editor.contiAuto");
  return (
    <div
      data-modal="editor-conti"
      onPointerDown={(e) => e.target === e.currentTarget && onClose()}
      onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } }}
      style={{ position: "fixed", inset: 0, zIndex: 90, background: "rgba(6,8,12,0.62)", display: "grid", placeItems: "center", padding: "var(--sp-6)" }}
    >
      <div style={{ background: "var(--bg)", border: "1px solid var(--line)", borderRadius: "var(--r-4)", padding: "var(--sp-5)", width: "min(560px, 92vw)", display: "flex", flexDirection: "column", gap: "var(--sp-4)", boxShadow: "var(--shadow-3)" }}>
        <b style={{ display: "flex", alignItems: "center", gap: 8, fontSize: "var(--text-md)" }}>{Icon.spark}{t("editor.conti")}</b>
        {row(has ? t("editor.contiNext") : t("editor.contiFirst"), (
          <textarea
            data-conti-text
            autoFocus
            value={text}
            onChange={(e) => { setText(e.target.value); lastText = e.target.value; }}
            onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void go(); } }}
            rows={4}
            style={{ ...box, width: "100%", boxSizing: "border-box", resize: "vertical", padding: "8px 10px", fontSize: "var(--text-xs)", lineHeight: 1.6, minHeight: 92 }}
          />
        ), true)}
        {row(t("editor.contiWhere"), <span data-conti-where style={{ fontSize: "var(--text-2xs)", color: "var(--ink-soft)" }}>{where}</span>)}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "10px 12px", paddingLeft: 106 }}>
          <label style={lab}>{t("editor.contiPages")}{sel("pages", [[0, auto], ...[1, 2, 3, 4, 5, 6, 8].map((n) => [n, String(n)] as [number, string])])}</label>
          <label style={lab}>{t("editor.contiMaxCuts")}{sel("maxCuts", [[0, auto], ...[3, 4, 5, 6, 7, 8].map((n) => [n, String(n)] as [number, string])])}</label>
          <label style={lab}>{t("editor.contiLayout")}{sel("layout", [["free", t("editor.contiFree")], ["template", t("editor.contiTemplate")]])}</label>
          <label style={lab}>{t("editor.readDir")}<span style={{ ...box, display: "block", padding: "4px 8px", color: "var(--ink-soft)" }}>{dirLabel}</span></label>
          <label style={lab}>{t("editor.contiLang")}{sel("lang", [["ko", LANG.ko], ["ja", LANG.ja], ["en", LANG.en]])}</label>
          <label style={lab}>{t("editor.contiPlace")}{sel("place", [["editor", PLACE.editor], ["nai", PLACE.nai], ["none", PLACE.none]])}</label>
        </div>
        {row(t("editor.contiCast"), <span style={hint}>{cast.join(" · ") || t("editor.contiNone")}</span>)}
        {row(t("editor.contiBgs"), <span style={hint}>{bgs.join(" · ") || t("editor.contiNone")}</span>)}
        {row(t("editor.contiRun"), (
          <span style={{ ...hint, display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
            {t("editor.contiRunText")}{engineLabel ? ` · ${engineLabel}` : ""}
            <button data-conti-settings onClick={() => { onClose(); useUi.getState().openSettings("llm"); }} style={{ color: "var(--accent-ink)", fontSize: "var(--text-2xs)" }}>{t("editor.contiSettings")}</button>
          </span>
        ))}
        <div style={{ display: "flex", gap: "var(--sp-2)", justifyContent: "flex-end" }}>
          <button data-modal-cancel onClick={onClose} style={btn}>{t("common.cancel")}</button>
          <button data-conti-go disabled={!text.trim()} onClick={() => void go()} style={{ ...btn, background: "var(--accent)", borderColor: "var(--accent)", color: "#fff", fontWeight: "var(--w-semi)", opacity: text.trim() ? 1 : 0.5 }}>
            {t("editor.contiGo")}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── 잠금 — 콘티를 만드는 동안 ─────────────────────────────────── */

/** 지켜보는 대화 — 이 대화가 턴을 마치거나 다른 대화로 옮기면 잠금이 풀린다 */
let watched: string | null = null;
let unsub: (() => void) | null = null;
function watch(docId: string) {
  release();
  useEditor.setState({ contiBusy: docId });
  watched = useLlm.getState().id;
  unsub = useLlm.subscribe((s, prev) => {
    if (s.id !== watched || (prev.sending && !s.sending)) release();
  });
}
function release() {
  unsub?.();
  unsub = null;
  watched = null;
  if (useEditor.getState().contiBusy) useEditor.setState({ contiBusy: null });
}

const lab: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 4, fontSize: "var(--text-2xs)", color: "var(--ink-faint)" };
const hint: React.CSSProperties = { fontSize: "var(--text-2xs)", color: "var(--ink-soft)" };
const btn: React.CSSProperties = { border: "1px solid var(--line)", borderRadius: "var(--r-2)", background: "var(--panel)", color: "var(--ink-soft)", padding: "var(--sp-2) var(--sp-5)", fontSize: "var(--text-xs)" };
