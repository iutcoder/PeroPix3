import { useEffect, useState } from "react";
import { useI18n } from "../i18n";
import { api, backendUrl, type TrashEntry } from "../lib/backend";
import { MAX_VIBES, pushVibe, type ImageInputStore } from "../store/imageInput";
import { ask } from "../store/ask";
import { toast, undoToast } from "../store/toast";
import { Icon } from "../components/Icon";

type Entry = {
  file: string;
  cache_key: string;
  model: string;
  info_extracted: number;
  strength: number;
  size: [number, number];
};

/** 한 항목의 속살 — 그림과 인코딩까지 (`/api/vibe-cache/{name}/data`) */
type Detail = {
  image: string;
  vibe_data: string | null;
  model: string;
  strength: number;
  info_extracted: number;
};

/** 바이브 캐시 뷰어 — **구워 둔 인코딩**을 보고 다시 쓰는 자리 (v2 6단계).
 *
 *  ★인코딩은 **돈이 나가는 호출**이다 (바이브당 2 Anlas). 같은 그림·같은 모델·같은 정보추출이면
 *    다시 굽지 않는데(`vibe.reuse_ok`), 그 판정이 보이지 않으면 사용자는 "또 돈이 나가나"를
 *    알 수 없다. 여기서 **무엇이 구워져 있는지**를 보이고, 눌러서 그대로 꺼내 쓴다.
 *  ★캐시에 남는 것은 **인코딩과 그림 한 장**이다 (긴 변 512 로 줄여 굽는다). 꺼내 쓸 때는
 *    **둘 다** 받아 온다 — 인코딩만 받으면 모델을 바꿨을 때 다시 구울 그림이 없고, 그림만
 *    받으면 돈이 다시 나간다. 예전에는 썸네일 주소만 알고 그림 자리를 비워 둬서
 *    **생성이 500 으로 죽었다** (빈 그림을 다시 인코딩하려다 났다).
 */
/** ★★**두 자리에서 쓴다** (사용자 지시 2026-08-25: *"갤러리 쪽에 vibe 전용 공간 만들어서
 *  거기에 보관"*). `onClose` 를 주면 **창**으로 뜨고(이미지 입력 패널의 단추), 안 주면
 *  **그 자리에 그대로** 그려진다 (갤러리의 바이브 칸).
 *  ★한 벌로 둔다 — 목록을 두 번 만들면 한쪽에서 지운 것이 다른 쪽에 남는다. */
export function VibeCache({ onClose, store }: { onClose?: () => void; /** 꺼낸 바이브를 넣을 한 벌. 없으면 생성 모드 것 */ store?: ImageInputStore }) {
  const t = useI18n((s) => s.t);
  const [items, setItems] = useState<Entry[] | null>(null);
  const [base, setBase] = useState("");
  const [busy, setBusy] = useState("");

  useEffect(() => {
    let alive = true;
    void (async () => {
      setBase(await backendUrl());
      try {
        const r = await api<{ items: Entry[] }>("/api/vibe-cache");
        if (alive) setItems(r.items);
      } catch {
        if (alive) setItems([]);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  /** 꺼내 쓰기 — **그림과 인코딩을 함께** 받아 온다 (v2 index.html:22620-22646) */
  const use = async (it: Entry) => {
    if (busy) return;
    setBusy(it.file);
    try {
      const d = await api<Detail>(`/api/vibe-cache/${encodeURIComponent(it.file)}/data`);
      if (!d.vibe_data) return toast(t("imgIn.cacheNoData"), "warn");
      const ok = pushVibe({
        image: d.image,
        name: it.file.replace(/\.png$/i, ""),
        strength: d.strength,
        info_extracted: d.info_extracted,
        encoded: d.vibe_data,
        encoded_model: d.model,
        encoded_info_extracted: d.info_extracted,
      }, store);
      if (!ok) return toast(t("imgIn.vibeFull", { n: MAX_VIBES }), "warn");
      /* ★창이면 꺼내 쓴 뒤 닫는다. 갤러리 칸에서는 **그대로 머문다** —
         거기서는 여러 개를 이어서 꺼내는 것이 자연스럽다. */
      toast(t("imgIn.vibeFileCached"));
      onClose?.();
    } catch (e) {
      toast(String(e), "warn");
    } finally {
      setBusy("");
    }
  };

  const remove = async (it: Entry) => {
    if (busy) return;
    if (!(await ask({
      title: t("imgIn.cacheDelete"),
      body: t("imgIn.cacheDeleteBody"),
      ok: t("common.delete"),
      cancel: t("common.cancel"),
      danger: true,
    })))
      return;
    setBusy(it.file);
    try {
      // ★휴지통을 거친다 (D7). 여기는 **Anlas 가 든 자리**라 되돌리기가 특히 중요하다 —
      //   캐시 키까지 같이 되살려야 다음 생성이 같은 그림을 다시 굽지 않는다.
      const r = await api<{ trashed: TrashEntry[]; keys: string[] }>(
        `/api/vibe-cache/${encodeURIComponent(it.file)}`,
        { method: "DELETE" },
      );
      setItems((xs) => (xs ?? []).filter((x) => x.file !== it.file));
      undoToast(t("common.trashed", { n: 1 }), t("common.undo"), async () => {
        await api("/api/vibe-cache/restore", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ entries: r.trashed, keys: r.keys }),
        });
        const back = await api<{ items: Entry[] }>("/api/vibe-cache");
        setItems(back.items);
        toast(t("common.restored"));
      });
    } catch (e) {
      toast(String(e), "warn");
    } finally {
      setBusy("");
    }
  };

  const body = (
    <>
        <div style={{ display: "flex", alignItems: "center", gap: "var(--sp-3)" }}>
          <b style={{ fontSize: "var(--text-md)" }}>{t("imgIn.cacheTitle")}</b>
          <span style={{ fontSize: "var(--text-2xs)", color: "var(--ink-faint)" }}>
            {t("imgIn.cacheHint")}
          </span>
          <span style={{ flex: 1 }} />
          {onClose && (
            <button data-vibe-cache-close onClick={onClose} style={{ color: "var(--ink-faint)", display: "grid" }}>
              {Icon.close}
            </button>
          )}
        </div>

        {items === null ? (
          <div style={{ padding: "var(--sp-6)", color: "var(--ink-faint)", fontSize: "var(--text-2xs)" }}>…</div>
        ) : items.length === 0 ? (
          <div style={{ padding: "var(--sp-6)", color: "var(--ink-faint)", fontSize: "var(--text-2xs)" }}>
            {t("imgIn.cacheEmpty")}
          </div>
        ) : (
          <div
            style={{
              flex: 1,
              minHeight: 0,
              overflowY: "auto",
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill,150px)",
              gap: "var(--sp-4)",
              justifyContent: "start",
            }}
          >
            {items.map((it) => (
              <div
                key={it.file}
                style={{
                  position: "relative",
                  border: "1px solid var(--line)",
                  borderRadius: "var(--r-2)",
                  overflow: "hidden",
                  background: "var(--panel)",
                  opacity: busy === it.file ? 0.5 : 1,
                }}
              >
                <button
                  data-vibe-cache-item={it.file}
                  disabled={!!busy}
                  onClick={() => void use(it)}
                  data-tip={t("imgIn.cacheUse")}
                  style={{ display: "block", width: "100%", padding: 0, textAlign: "left" }}
                >
                  <img
                    src={`${base}/api/vibe-cache/${encodeURIComponent(it.file)}`}
                    alt=""
                    loading="lazy"
                    style={{ width: "100%", aspectRatio: "1 / 1", objectFit: "cover", display: "block" }}
                  />
                  <div style={{ padding: "var(--sp-2) var(--sp-3)", fontSize: "var(--text-2xs)" }}>
                    <div style={{ color: "var(--ink-soft)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {it.model.replace("nai-diffusion-", "")}
                    </div>
                    <div style={{ color: "var(--ink-faint)", fontFamily: "var(--font-mono)" }}>
                      {t("imgIn.refStrength")} {it.strength} · {t("imgIn.info")} {it.info_extracted}
                    </div>
                  </div>
                </button>
                {/* ★지우면 그 그림은 **다시 사야 한다** (인코딩은 유료라 캐시가 곧 돈이다).
                    그래서 확인을 받고, 되돌릴 수 없다고 알린다 */}
                <button
                  data-vibe-cache-del={it.file}
                  disabled={!!busy}
                  onClick={() => void remove(it)}
                  data-tip={t("imgIn.cacheDelete")}
                  style={{
                    position: "absolute",
                    top: "var(--sp-2)",
                    right: "var(--sp-2)",
                    display: "grid",
                    placeItems: "center",
                    width: 24,
                    height: 24,
                    borderRadius: "var(--r-1)",
                    background: "rgba(6,8,12,0.62)",
                    color: "var(--ink-soft)",
                  }}
                >
                  {Icon.trash}
                </button>
              </div>
            ))}
          </div>
        )}
    </>
  );

  /* ★그 자리에 그대로 그린다 (갤러리의 바이브 칸) — 창으로 뜨는 것은 `onClose` 가 있을 때만 */
  if (!onClose)
    return (
      <div
        data-vibe-cache="inline"
        style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", gap: "var(--sp-3)", padding: "var(--sp-4)" }}
      >
        {body}
      </div>
    );

  return (
    <div
      data-vibe-cache
      onPointerDown={(e) => e.target === e.currentTarget && onClose()}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 80,
        background: "rgba(6,8,12,0.6)",
        display: "grid",
        placeItems: "center",
        padding: "var(--sp-6)",
      }}
    >
      <div
        style={{
          background: "var(--bg)",
          border: "1px solid var(--line)",
          borderRadius: "var(--r-4)",
          padding: "var(--sp-5)",
          width: "min(760px, 92vw)",
          maxHeight: "82vh",
          display: "flex",
          flexDirection: "column",
          gap: "var(--sp-4)",
        }}
      >
        {body}
      </div>
    </div>
  );
}