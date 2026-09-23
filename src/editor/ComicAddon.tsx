import { useEffect, useState } from "react";
import { useI18n } from "../i18n";
import { Icon } from "../components/Icon";
import { backendUrl } from "../lib/backend";
import { fresh, isOn, useThemeName, usePickText, usePlugins, type PluginDrawer } from "../lib/pluginHost";
import { compileBlocks, makeBlock, parseSegs, type Block } from "../lib/blocks";
import { BlockList } from "../blocks/BlockList";
import { dropFocus } from "../panels/censor/ui";
import { CAST_NEUTRAL, type Handed } from "./comic";
import { useEditor, type Doc } from "./store";
import type { Layer } from "./pixels";
import "./comicBridge";

/** 만화 페이지의 **애드온** 자리 — 플러그인이 채우는 곳만 모았다 (설계 `docs/comic-editor-design.md` 10-1 · 목업 ⑥⑦).
 *  ★기본 화면에 섞지 않고 떨어져 보이게 둔다: 서랍 레일·서랍은 기둥 오른쪽 따로, 애드온 띠·넘겨받은 프롬프트 칸은
 *    플러그인 모드 색(`--mode-plugins`)으로 두른다. 서랍을 쓰는 플러그인이 없으면 레일도 서랍도 없다 (`PluginSlot` 과 같은 규칙). */

const DRAWER_SLOT = "editor.comic";
const NO_DRAWERS: PluginDrawer[] = [];
const ADDON = "var(--mode-plugins)";

/** 이 자리를 쓰는 서랍들 (켜진 플러그인만) */
export function useComicDrawers(): PluginDrawer[] {
  const all = usePlugins((s) => s.drawers[DRAWER_SLOT] ?? NO_DRAWERS);
  usePlugins((s) => s.items); // 켜고 끄기가 바뀌면 다시 그린다
  return all.filter((d) => isOn(d.plugin));
}

/** 오른쪽 끝 레일 — 서랍을 쓰는 플러그인의 아이콘. 누르면 그 서랍을 열고, 다시 누르면 닫는다 */
export function DrawerRail({ drawers, open, onOpen }: { drawers: PluginDrawer[]; open: string | null; onOpen: (key: string | null) => void }) {
  const pick = usePickText();
  return (
    <div data-editor-drawer-rail style={{ width: 40, flexShrink: 0, display: "flex", flexDirection: "column", alignItems: "center", gap: 4, paddingTop: 2 }}>
      {drawers.map((d) => {
        const on = open === d.key;
        return (
          <button
            key={d.key}
            data-editor-drawer-open={d.plugin}
            data-on={on ? "" : undefined}
            onMouseDown={dropFocus}
            onClick={() => onOpen(on ? null : d.key)}
            data-tip={pick(d.label)}
            style={{
              width: 34, height: 34, display: "grid", placeItems: "center", borderRadius: "var(--r-2)",
              border: `1px solid ${on ? ADDON : "var(--line)"}`,
              background: on ? `color-mix(in srgb, ${ADDON} 18%, var(--panel))` : "var(--panel)",
              color: on ? "var(--ink)" : "var(--ink-soft)",
            }}
          >
            {d.icon ? <span aria-hidden style={{ display: "grid", placeItems: "center", width: 16, height: 16 }} dangerouslySetInnerHTML={{ __html: d.icon }} /> : Icon.plug}
          </button>
        );
      })}
    </div>
  );
}

/** 서랍 — 틀(머리 · 닫기 · 폭)만 앱이 그리고, 안은 플러그인 페이지다 */
export function DrawerPanel({ drawer, onClose }: { drawer: PluginDrawer; onClose: () => void }) {
  const t = useI18n((s) => s.t);
  const pick = usePickText();
  const theme = useThemeName();
  const [base, setBase] = useState("");
  useEffect(() => {
    void backendUrl().then(setBase);
  }, []);
  return (
    <div
      data-editor-drawer={drawer.plugin}
      style={{ width: drawer.width, flexShrink: 0, display: "flex", flexDirection: "column", minHeight: 0, border: `1px solid ${ADDON}`, borderRadius: "var(--r-3)", overflow: "hidden", background: "var(--panel)" }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 8px 6px 10px", borderBottom: "1px solid var(--line)", fontSize: "var(--text-xs)", fontWeight: "var(--w-semi)", color: "var(--ink)" }}>
        <span style={{ display: "grid", color: ADDON }}>
          {drawer.icon ? <span aria-hidden style={{ display: "grid", placeItems: "center", width: 14, height: 14 }} dangerouslySetInnerHTML={{ __html: drawer.icon }} /> : Icon.plug}
        </span>
        <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{pick(drawer.label)}</span>
        <button data-editor-drawer-close onMouseDown={dropFocus} onClick={onClose} data-tip={t("editor.drawerClose")} style={{ display: "grid", color: "var(--ink-faint)", padding: 2 }}>
          {Icon.close12}
        </button>
      </div>
      <div style={{ flex: 1, minHeight: 0, position: "relative" }}>
        {base && (
          <iframe
            data-plugin-frame={drawer.plugin}
            title={pick(drawer.label)}
            src={`${base}${drawer.url}${fresh(drawer.url)}`}
            style={{ position: "absolute", inset: 0, width: "100%", height: "100%", border: "none", background: "transparent", colorScheme: theme }}
          />
        )}
      </div>
    </div>
  );
}

/** 무대 위 애드온 띠 — 이 캔버스에 콘티를 깐 플러그인 · 프로젝트와 페이지 · 모드 · 말풍선 담당 (목업 ⑦) */
export function AddonBand({ doc }: { doc: Doc }) {
  const t = useI18n((s) => s.t);
  const a = doc.comic?.addon;
  if (!a) return null;
  const sep = <span style={{ color: "var(--ink-ghost)" }}>·</span>;
  return (
    <div
      data-editor-addon-band
      style={{
        display: "flex", alignItems: "center", gap: 8, minHeight: 26, padding: "3px 10px", borderRadius: "var(--r-2)",
        border: `1px solid ${ADDON}`, background: `color-mix(in srgb, ${ADDON} 10%, var(--bg))`, fontSize: "var(--text-2xs)", color: "var(--ink-soft)",
      }}
    >
      <span style={{ display: "inline-flex", alignItems: "center", gap: 5, color: "var(--ink)", fontWeight: "var(--w-semi)" }}>
        <span style={{ display: "grid", color: ADDON }}>{Icon.plug}</span>
        {a.name}
      </span>
      {a.label && <><span>{a.label}</span>{sep}</>}
      <span>{t(a.mode === "page" ? "editor.addonPageMode" : "editor.addonCutMode")}</span>
      {sep}
      <span>{t(a.bubbles === "editor" ? "editor.addonBubbleEditor" : "editor.addonBubbleNai")}</span>
    </div>
  );
}

/** 글 → 블록 하나 (넘겨받은 프롬프트를 블록 칸으로 고친다). ★원문을 `src` 로 들고 있어 안 건드리면 글자 그대로 나간다 */
const blockOf = (id: string, text: string): Block => ({ ...makeBlock("", [], { id, open: true }), tags: parseSegs(text), src: text });

/** 고른 컷의 「넘겨받은 프롬프트」 칸 — 기본의 「컷 프롬프트 · 인물」 자리에 선다 (목업 ⑦).
 *  베이스와 인물마다의 캐릭터 프롬프트를 블록 칸으로 고칠 수 있다. 번호는 콘티의 흐름 번호 그대로다 */
export function HandedSection({ doc, panel }: { doc: Doc; panel: Layer }) {
  const t = useI18n((s) => s.t);
  const s = useEditor();
  const h: Handed = panel.panel!.gen!.handed!;
  const a = doc.comic?.addon;
  const nai = a?.bubbles !== "editor";
  const badge = (n: number, color: string, round: boolean) => (
    <i style={{ width: 16, height: 16, borderRadius: round ? "50%" : 4, background: color, color: "#fff", fontStyle: "normal", fontSize: 10, fontWeight: 600, display: "inline-grid", placeItems: "center", flexShrink: 0 }}>{n}</i>
  );
  const k = (label: React.ReactNode) => <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: "var(--text-2xs)", color: "var(--ink-faint)" }}>{label}</div>;
  return (
    <div data-editor-handed style={{ border: `1px solid ${ADDON}`, borderRadius: "var(--r-2)", overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "5px 8px", background: `color-mix(in srgb, ${ADDON} 12%, var(--bg))`, fontSize: "var(--text-2xs)", color: "var(--ink)", fontWeight: "var(--w-semi)" }}>
        <span style={{ display: "grid", color: ADDON }}>{Icon.plug}</span>
        {a?.name ?? t("editor.handed")}
        {h.summary && <small data-tip={h.summary} style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--ink-faint)", fontWeight: "var(--w-normal)", textAlign: "right" }}>{h.summary}</small>}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: 8 }}>
        {k(t("editor.handedBase"))}
        <div data-editor-handed-base>
          <BlockList single fill id={`handed-${panel.id}-base`} blocks={[blockOf(`hb-${panel.id}`, h.base)]} onChange={(b) => s.setHanded(panel.id, { base: compileBlocks(b) })} libZone={`handed-${panel.id}-base`} />
        </div>
        {h.empty ? k(<>{badge(h.empty, CAST_NEUTRAL, false)}{t("editor.handedEmpty")}</>) : null}
        {h.chars.map((c, i) => (
          <div key={`${c.no}-${i}`} data-editor-handed-char={c.no} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {k(<>{badge(c.no, c.color, true)}<span style={{ color: "var(--ink-soft)" }}>{c.name}</span></>)}
            <BlockList
              single
              fill
              id={`handed-${panel.id}-c${i}`}
              blocks={[blockOf(`hc-${panel.id}-${i}`, c.prompt)]}
              onChange={(b) => s.setHanded(panel.id, { chars: h.chars.map((x, j) => (j === i ? { ...x, prompt: compileBlocks(b) } : x)) })}
              libZone={`handed-${panel.id}-c${i}`}
            />
            {nai && c.lines.length > 0 && <span style={{ fontSize: "var(--text-3xs)", color: "var(--ink-faint)" }}>{c.lines.map((x) => `「${x}」`).join(" ")}</span>}
          </div>
        ))}
        {nai && h.notes.map((n, i) => (
          <div key={`n${n.no}-${i}`} data-editor-handed-note={n.no}>
            {k(<>{badge(n.no, CAST_NEUTRAL, false)}{t("editor.narration")}<span style={{ color: "var(--ink-soft)" }}>{n.text}</span></>)}
          </div>
        ))}
      </div>
    </div>
  );
}
