/** 결과 레코드와 **묶는 규칙** — ★사용자 그림이 화면에서 사라지느냐가 걸린 자리라
 *  앱 의존이 없는 모듈로 떼어 회귀 테스트를 붙였다 (`sceneCards.test.ts`).
 *  `store/workspace.ts` 가 그대로 다시 내보낸다 — 부르는 쪽은 안 바뀐다. */

export type Rec = {
  ts: string;
  file: string;
  /** 세트 **이름** — 옛 레코드가 id 없이 이것만 남겼다 (`scene_group_id` 주석) */
  scene_group: string;
  cell: string | null;
  /** ★화면이 결과를 묶는 **진짜 키**. 옛 레코드에는 없다 (append-only JSONL 이라 소급 불가). */
  scene_group_id?: string | null;
  cell_id?: string | null;
  seed: number;
  /** 이 그림이 **어느 그림에서 나왔나** (강화·업스케일·인페인트의 원본).
   *  ★**묶는 데 쓰지 않는다** — 결과는 언제나 각각 별개의 그림으로 보인다
   *  (사용자 결정 2026-08-13: v2 의 버전 스택 `1/n` 은 작업할 때 오히려 불편하다).
   *  출처 기록일 뿐이므로, 이 값으로 결과를 묶는 코드를 새로 만들지 말 것. */
  enhance_of?: string | null;
  resolved?: unknown;
  /** ★**미저장** — 「자동 저장」을 껐을 때 나온 그림 (v2 `isPreviewOnly`).
   *
   *  파일이 없으므로 `file` 은 진짜 경로가 아니라 **표식**이고(`store/previews.ts` 의
   *  `PREVIEW_PREFIX`), 이 레코드는 **메모리에만** 산다 — `records.jsonl` 에 절대 안 들어간다.
   *  v2 도 같았다: 미저장 카드는 저장된 카드와 **같은 자리**에 들어가고 파일명 자리에
   *  「미저장」이 뜰 뿐이다 (`index.html:12146-12170`).
   *  ★묶는 규칙은 그대로 `takesOf` 가 판정한다 — 미저장이라고 다른 창구를 만들지 말 것. */
  preview?: { b64: string; fmt: string } | null;
};

/** 레코드의 시각 문자열 — **서버와 같은 자**여야 한다 (`backend/server.py` 의
 *  `datetime.now().isoformat(timespec="seconds")`).
 *
 *  ★★`toISOString()` 을 쓰지 말 것 (사용자 지적 2026-08-19). 그쪽은 **UTC + `Z`** 라
 *    지역시각(+09:00)으로 적힌 서버 기록과 문자열 비교가 어긋난다 — 방금 만든 그림이
 *    아홉 시간 옛것으로 줄 뒤에 섰다. 서버가 `ts` 를 보내 주면 그것을 쓰고, 이건 폴백이다. */
export const localTs = () => {
  const d = new Date();
  const p2 = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}` +
    `T${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`
  );
};

/** 줄에 놓는 차례 — **최신이 왼쪽**이다 (사용자 지시 2026-08-14).
 *
 *  ★★자리는 **`ts` 가 정한다.** 예전에는 `records` 에 담긴 차례를 뒤집어 썼는데, 그 차례는
 *    "언제 도착했나"라서 경로마다 다르다 (파일에서 읽기 · 생성 중 WebSocket · 복원 · 미저장
 *    미리보기). 사용자 지적 2026-08-19: **대기 칸은 왼쪽에 생기는데 결과는 오른쪽으로 쌓였다.**
 *  ★같은 초에 나온 것은 **파일 이름**으로 가른다 — 이름 끝의 번호가 곧 만든 차례다.
 */
export const newestFirst = (a: Rec, b: Rec) =>
  a.ts === b.ts ? (a.file < b.file ? 1 : a.file > b.file ? -1 : 0) : a.ts < b.ts ? 1 : -1;

/** 결과를 탭·슬롯에 묶는 **유일한 창구**.
 *
 *  ★폴더명은 사람이 읽을 수 있게 이름을 그대로 쓴다. 이름을 바꾸면 그림도 새 이름의 폴더로
 *    옮겨진다 (사용자 결정 2026-09-29, `store/workspace.ts` 의 `renamePlace`). 그래도 묶는 것은
 *    이름이 아니라 id 다 — 화면이 이름으로 묶던 때는 이름을 고치는 순간 결과가 통째로 사라졌다.
 *  ★id 우선·이름 폴백. 옛 레코드(id 없음)도 계속 보여야 한다.
 *  ★판정을 여러 곳에 흩뿌리면 폴백 규칙이 어긋난다 — 고칠 때는 여기만 고친다.
 *
 *  @param cell 슬롯. `null` 은 "셀 없는 것", `undefined` 는 "셀을 안 따진다". */
/** 이 탭(·슬롯)의 결과를 고른다 — **화면이 결과를 묶는 유일한 창구**다.
 *
 *  ★레코드에 `scene_group_id` 가 없으면 이름으로 맞춘다 (id 이전에 만든 레코드 호환). 그런데 그 폴백이
 *    **새 탭에도 걸려서**, 같은 이름(`새 세트`)으로 탭을 만들면 만든 적 없는 그림이 떴다
 *    (사용자 지적 2026-08-04). 새 탭은 `idOnly` 라 폴백을 건너뛴다 — 옛 탭에만 남긴다. */
/** ★★**같은 파일을 가리키는 줄은 하나로 접는다** (사용자 지적 2026-08-24: *"여러개가
 *  중복표시되고 하나를 누르면 중복으로 뜬게 전부 선택"*).
 *
 *  레코드는 append-only 인데, 생성이 **옛 파일 이름을 다시 쓰면** 같은 경로를 가리키는 줄이
 *  둘이 된다 (번호가 되돌아가던 문제 — `backend/workspace.next_name` 이 이제 레코드까지
 *  세어 막는다). 그렇게 이미 생긴 줄은 화면에서 **한 장**으로 보여야 한다:
 *  화면은 경로를 그림의 신원으로 쓰므로(고르기·지움·별표) 두 장으로 두면 하나를 눌러도
 *  둘 다 잡힌다.
 *  ★남기는 것은 **마지막 줄**이다 — 그 자리에 실제로 있는 그림은 나중에 쓴 것이다
 *    (`store/workspace.addRecord` 가 실시간 충돌에서 내리는 판단과 같다).
 *  ★원장(`records.jsonl`)은 **안 고친다.** 여기는 읽는 쪽이고, 파일은 사실의 기록이다. */
export function dedupeByFile(records: Rec[]): Rec[] {
  const at = new Map<string, number>();
  const out: Rec[] = [];
  for (const r of records) {
    const seen = at.get(r.file);
    if (seen === undefined) {
      at.set(r.file, out.length);
      out.push(r);
    } else {
      out[seen] = r; // 나중 줄이 이긴다 (자리는 처음 나온 차례를 지킨다)
    }
  }
  return out;
}

export function takesOf(
  records: Rec[],
  tab: { id: string; name: string; idOnly?: boolean },
  cell?: { id: string; name: string } | null,
): Rec[] {
  return records.filter((r) => {
    if (!r.scene_group_id && tab.idOnly) return false;
    if (r.scene_group_id ? r.scene_group_id !== tab.id : r.scene_group !== tab.name) return false;
    if (cell === undefined) return true;
    if (cell === null) return r.cell == null;
    if (!r.cell_id && tab.idOnly) return false;
    return r.cell_id ? r.cell_id === cell.id : r.cell === cell.name;
  });
}

/** ★이미 경고한 파일 — 렌더마다 부르는 자리라 한 번씩만 남긴다 */
const warned = new Set<string>();

/** 씬 하나의 결과 — **갈 자리를 못 찾은 것은 첫 씬이 받는다** (v2 `index.html:12111-12121`).
 *
 *  v2 는 그림이 도착했을 때 슬롯 번호가 범위를 벗어나면 `slots[0]` 에 넣고
 *  `console.warn` 을 남겼다. 3.0 은 도착 시점이 아니라 **레코드에서 화면을 만들므로**
 *  같은 일을 여기서 한다. 그러지 않으면 생성 중에 그 씬을 지웠을 때 파일도 레코드도
 *  남아 있는데 **화면 어디에도 안 뜬다** (감사 D6).
 *
 *  ★고아 판정은 `takesOf` 를 그대로 써서 낸다 — 「이 탭의 결과 전부」에서
 *    「어느 씬이든 가져간 것」을 뺀 나머지다. 묶는 규칙을 여기 두 번 적지 않는다.
 *  ★씬이 하나도 없으면 받을 자리가 없다 — v2 도 그때는 그냥 버렸다(`return`).
 *
 *  @param cells 그 탭의 **모든 씬** (카드 순서대로). 첫 번째가 받는 자리다. */
export function takesOfScene(
  records: Rec[],
  tab: { id: string; name: string; idOnly?: boolean },
  cells: { id: string; name: string }[],
  cell: { id: string; name: string },
): Rec[] {
  const mine = takesOf(records, tab, cell);
  if (!cells.length || cells[0].id !== cell.id) return mine;

  const claimed = new Set<string>();
  for (const c of cells) for (const r of takesOf(records, tab, c)) claimed.add(r.file);
  const orphans = takesOf(records, tab, undefined).filter((r) => !claimed.has(r.file));
  for (const r of orphans) {
    if (warned.has(r.file)) continue;
    warned.add(r.file);
    console.warn(
      `[takes] 갈 씬이 없는 결과 → 첫 씬(${cell.name})에 붙입니다: ${r.file}` +
        ` (tab=${tab.name}, cell_id=${r.cell_id ?? "없음"})`,
    );
  }
  // ★만든 차례를 지킨다 — 고아를 뒤에 몰아 붙이면 줄에서 시간 순서가 어긋난다
  return orphans.length ? [...mine, ...orphans].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0)) : mine;
}
