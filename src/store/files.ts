import { create } from "zustand";
import { api, type TrashEntry } from "../lib/backend";
import { t } from "../i18n";
import { toast, undoToast } from "./toast";

/** 파일 관리 — **아웃풋 폴더를 그대로** 보여준다 (v2 `파일 관리` 탭).
 *
 *  ★갤러리와 다른 것 하나: 여기는 **워크스페이스를 넘는다.** 아웃풋 루트가 뿌리라
 *    경로도 워크스페이스가 아니라 루트 기준이다 (`backend/files.py` 머리 주석).
 *  ★목록에서 그림을 열지 않는다 — 화면은 썸네일로 그린다.
 */
export type FileNode = { name: string; path: string; count: number; children: FileNode[] };
export type FileItem = { file: string; name: string; bytes: number; mtime: number };
type FilePage = { items: FileItem[]; total: number; page: number; pages: number };

type S = {
  tree: FileNode[];
  rootCount: number;
  folder: string;
  items: FileItem[];
  picked: Set<string>;
  /** ★Shift 범위의 기준점 (v2 `fm.anchorIndex`, index.html:26945-26987).
   *  탐색기와 같다: Ctrl 은 하나씩 토글하고 **Shift 는 앵커부터 여기까지**를 통째로 고른다.
   *  예전에는 둘을 똑같이 토글로 처리해서 범위 선택이 아예 없었다 (감사 C7). */
  anchor: number;
  open: Set<string>;
  loading: boolean;
  /** ★쪽 나눠 받는다 (gallery 와 같은 규칙) */
  page: number;
  total: number;
  hasMore: boolean;
  loadTree: () => Promise<void>;
  go: (folder: string) => Promise<void>;
  /** 다음 쪽 — 스크롤이 바닥에 가까워지면 */
  more: () => Promise<void>;
  reload: () => Promise<void>;
  toggleOpen: (path: string) => void;
  /** 한 칸을 누른 결과 — 수식키가 뜻을 가른다 (`ctrl` 토글 · `shift` 범위) */
  pick: (index: number, mod?: { ctrl?: boolean; shift?: boolean }) => void;
  /** 마키(드래그)로 훑은 범위를 **더한다** — 시작 칸부터 지금 칸까지 */
  pickRange: (from: number, to: number) => void;
  pickAll: () => void;
  clearPick: () => void;
  mkdir: (parent: string, name: string) => Promise<void>;
  rename: (path: string, name: string) => Promise<void>;
  move: (files: string[], dest: string) => Promise<void>;
  remove: (files: string[]) => Promise<void>;
  reveal: (path: string) => Promise<void>;
  /** 절대 경로 폴더를 연다 (아웃풋 루트 밖 — 검열 저장 자리). `reveal` 은 루트 안만 연다 */
  openDir: (path: string) => Promise<void>;
};

export const useFiles = create<S>((set, get) => ({
  tree: [],
  rootCount: 0,
  folder: "",
  items: [],
  picked: new Set(),
  anchor: -1,
  open: new Set(),
  loading: false,
  page: 1,
  total: 0,
  hasMore: false,

  async loadTree() {
    const r = await api<{ count: number; tree: FileNode[] }>("/api/files/tree");
    set({ tree: r.tree, rootCount: r.count });
    // ★첫 층은 펼쳐 둔다 — 워크스페이스 이름이 첫 층이라 접혀 있으면 빈 화면처럼 보인다
    if (!get().open.size) set({ open: new Set(r.tree.map((n) => n.path)) });
  },

  async go(folder) {
    set({ folder, loading: true, picked: new Set(), anchor: -1 });
    try {
      const r = await api<FilePage>(`/api/files/list?page=1&folder=${encodeURIComponent(folder)}`);
      set({ items: r.items, page: r.page, total: r.total, hasMore: r.page < r.pages });
    } finally {
      set({ loading: false });
    }
  },

  async more() {
    const { loading, hasMore, page, folder, items } = get();
    if (loading || !hasMore) return;
    set({ loading: true });
    try {
      const r = await api<FilePage>(
        `/api/files/list?page=${page + 1}&folder=${encodeURIComponent(folder)}`,
      );
      const seen = new Set(items.map((i) => i.file));
      set({
        items: [...items, ...r.items.filter((i) => !seen.has(i.file))],
        page: r.page,
        total: r.total,
        hasMore: r.page < r.pages,
      });
    } finally {
      set({ loading: false });
    }
  },

  async reload() {
    await get().loadTree();
    await get().go(get().folder);
  },

  toggleOpen(path) {
    const next = new Set(get().open);
    next.has(path) ? next.delete(path) : next.add(path);
    set({ open: next });
  },

  pick(index, mod) {
    const { items, picked, anchor } = get();
    const it = items[index];
    if (!it) return;

    // ★Shift — 앵커부터 여기까지. 앞선 선택은 버린다 (탐색기와 같다)
    if (mod?.shift && anchor >= 0) {
      const [a, b] = anchor < index ? [anchor, index] : [index, anchor];
      return set({ picked: new Set(items.slice(a, b + 1).map((x) => x.file)) });
    }

    // Ctrl — 하나씩 더하고 뺀다. 앵커는 **더할 때만** 새로 잡는다
    if (mod?.ctrl) {
      const next = new Set(picked);
      if (next.has(it.file)) {
        next.delete(it.file);
        return set({ picked: next, anchor: next.size ? anchor : -1 });
      }
      next.add(it.file);
      return set({ picked: next, anchor: anchor < 0 ? index : anchor });
    }

    // 맨 클릭 — 이것 하나만. 같은 것을 또 누르면 푼다
    const only = picked.has(it.file) && picked.size === 1;
    set({ picked: new Set(only ? [] : [it.file]), anchor: only ? -1 : index });
  },

  pickRange(from, to) {
    const { items, picked, anchor } = get();
    const [a, b] = from < to ? [from, to] : [to, from];
    const next = new Set(picked);
    for (const it of items.slice(a, b + 1)) next.add(it.file);
    set({ picked: next, anchor: anchor < 0 ? from : anchor });
  },

  pickAll() {
    const { items, picked } = get();
    const all = picked.size === items.length;
    set({ picked: new Set(all ? [] : items.map((i) => i.file)), anchor: all ? -1 : 0 });
  },

  clearPick: () => set({ picked: new Set(), anchor: -1 }),

  async mkdir(parent, name) {
    await api("/api/files/mkdir", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: parent, name }),
    });
    await get().loadTree();
  },

  async rename(path, name) {
    await api("/api/files/rename", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path, name }),
    });
    await get().reload();
  },

  async move(files, dest) {
    await api("/api/files/move", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ files, dest }),
    });
    await get().reload();
  },

  /** ★지우기는 **휴지통을 거친다** (사용자 결정 2026-08-18, v2-port-audit D7).
   *  폴더도 통째로 담기고, 되돌리면 안에 든 것까지 그대로 돌아온다.
   *  ★되돌리기 창구는 **토스트의 단추**다 — 파일 관리에는 `Ctrl+Z` 를 받을 자리가 없다
   *    (캔버스와 달리 키를 먹는 화면이 아니다). */
  async remove(files) {
    const r = await api<{ deleted: string[]; trashed: TrashEntry[] }>("/api/files/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ files }),
    });
    await get().reload();
    if (r.trashed?.length)
      undoToast(t("common.trashed", { n: r.trashed.length }), t("common.undo"), async () => {
        await api("/api/files/restore", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ entries: r.trashed }),
        });
        await get().loadTree();
        await get().reload();
        toast(t("common.restored"));
      });
  },

  async reveal(path) {
    await api("/api/files/reveal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    });
  },

  async openDir(path) {
    await api("/api/files/open-dir", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    });
  },
}));
