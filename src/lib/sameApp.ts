import { toast } from "../store/toast";
import type { Health } from "../store/health";

/** 지금 붙은 백엔드가 **내 것인가** (사용자 지시 2026-08-26, 포터블 준비).
 *
 *  ★★포터블은 **여러 벌을 다른 폴더에 풀어 두고 함께 쓰는** 형식이다. 예전에는 포트가
 *    8770 하나로 박혀 있어, 나중에 켠 쪽의 사이드카가 바인딩에 실패해도 창은 그대로
 *    8770 에 붙었다 — **창은 이쪽인데 데이터는 저쪽**이 되고, 그것이 조용히 일어났다
 *    (실측 2026-08-08: 원인이 화면에 안 나왔다).
 *  ★이제 포트는 인스턴스마다 다르게 잡지만(`backend.rs` 의 `backend_port`), 잡았다 놓는
 *    사이에 남이 채 가는 창이 남는다. 그래서 **붙고 나서 한 번 대조한다.**
 *  ★대조하는 값은 **앱이 서 있는 폴더**다 — 데이터가 쌓이는 자리가 곧 그 폴더라
 *    (`server.py` 의 `APP_DIR`), 이것이 같으면 창고도 같다.
 *  ★브라우저(vite dev)에서는 Tauri 가 없어 물어볼 상대가 없다 — 그때는 **넘어간다.**
 *  @returns 남의 백엔드면 false (부르는 쪽이 멈춰야 한다)
 */
export async function sameApp(h: Health): Promise<boolean> {
  let mine = "";
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    mine = await invoke<string>("app_root");
  } catch {
    return true; // Tauri 밖 — 대조할 수 없다
  }
  if (!mine || !h.root) return true;
  if (norm(mine) === norm(h.root)) return true;
  console.error(`[app] 남의 백엔드에 붙었습니다: 내 자리 ${mine} / 백엔드 ${h.root}`);
  toast(`다른 PeroPix 의 백엔드에 붙었습니다 (${h.root}). 그 앱을 닫고 다시 켜 주세요.`, "warn");
  return false;
}

/** 윈도우 경로는 대소문자·구분자·끝 슬래시가 흔들린다 — 뜻이 같으면 같게 본다 */
const norm = (p: string) => {
  /* ★`..` 도 접는다 (2026-09-07) — QA 호스트는 뿌리를 `…\PeroPix3\..\PeroPix3-qaroot` 꼴로 주는데
     백엔드는 접힌 경로를 말하므로, 글자로 견주면 같은 자리를 다른 자리로 본다. */
  const out: string[] = [];
  for (const seg of p.replace(/\\/g, "/").split("/")) {
    if (seg === "..") out.pop();
    else if (seg !== "." && seg !== "") out.push(seg);
  }
  return out.join("/").toLowerCase();
};
