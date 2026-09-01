import { useEffect } from "react";
import { useI18n } from "../i18n";
import { Icon } from "../components/Icon";
import { taggerPct, useTagger } from "../store/tagger";
import { useUi } from "../store/ui";

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)}MB`;

/** 타이틀바의 태거 모델 띠 — **업데이트 띠(`UpdateStrip`)와 같은 모양**이다
 *  (사용자 지시 2026-08-29: 업데이트 UI 를 활용해 상단에 모델 내려받기 진행도).
 *
 *  ★어디서 무엇을 하고 있든 보인다 — 탭·모달과 무관하게 늘 떠 있는 자리가 타이틀바뿐이다.
 *  ★아무 일도 없을 때는 아무것도 안 그린다.
 *  ★부팅 때 한 번 상태를 묻는다 — 앱을 켠 채 서버가 받고 있던 것이 있으면 곧바로 보인다.
 *  ★누르면 보조도구 › Tagger 로 간다 (업데이트 띠가 설정으로 가는 것과 같은 몸짓). */
export function TaggerStrip() {
  const t = useI18n((s) => s.t);
  const st = useTagger((s) => s.st);
  useEffect(() => {
    void useTagger.getState().refresh();
  }, []);
  if (!st?.downloading) return null;
  const pct = taggerPct(st);

  return (
    <span
      data-tagger-strip
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "var(--sp-2)",
        fontSize: "var(--text-2xs)",
        color: "var(--ink-dim)",
        paddingRight: "var(--sp-3)",
      }}
    >
      <button
        data-tagger-strip-open
        onClick={() => {
          useUi.getState().setMode("utility");
          useUi.getState().setView("tab", "tools", "tagger" as never);
        }}
        data-tip={t("tagger.title")}
        style={{ color: "var(--ink-dim)" }}
      >
        {t("tagger.strip", { done: mb(st.got), total: mb(st.total) })}
      </button>
      {/* ★막대는 **받은 만큼**이다 — 총량을 모르면(0) 안 채운다 */}
      <span style={{ width: 64, height: 4, borderRadius: 2, background: "var(--line)", overflow: "hidden" }}>
        <span
          data-tagger-strip-bar
          style={{ display: "block", width: `${pct}%`, height: "100%", background: "var(--accent)", transition: "width 0.2s" }}
        />
      </span>
      <button
        data-tagger-strip-cancel
        onClick={() => void useTagger.getState().cancel()}
        data-tip={t("tagger.dlCancel")}
        style={{ color: "var(--ink-faint)", display: "grid" }}
      >
        {Icon.close}
      </button>
    </span>
  );
}
