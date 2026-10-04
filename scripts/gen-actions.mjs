/** 액션 목록을 **빌드할 때** 뽑아 백엔드가 읽을 파일로 쓴다 (2026-08-24).
 *
 *  ★★왜 빌드 시점인가: 앱이 접속할 때 목록을 올려 보내던 방식은 **이미 써 보고 버렸다.**
 *    화면이 붙는 순간에만 올려서, 코드가 갱신돼도(HMR) 소켓이 그대로면 영영 안 올라가
 *    **도구가 0개**로 보였다 (`backend/agent.py` 머리 주석). 파일로 두면 목록이 앱·소켓
 *    타이밍과 무관하게 언제나 같다.
 *
 *  ★소스를 **읽어서** 뽑는다 (실행하지 않는다): 액션 파일은 zustand 스토어를 부르므로
 *    노드에서 그냥 import 하면 브라우저 전용 코드에 걸린다. `defineAction({...})` 블록의
 *    `id`·`desc`·`args` 만 정규식으로 떠낸다 — 그 셋은 **리터럴로만** 적는 규약이다.
 *
 *  실행: node scripts/gen-actions.mjs   (npm run build 앞·test.bat 안에서 함께 돈다)
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, "..", "src", "lib", "appActions.ts");
const OUT = join(here, "..", "backend", "actions.json");

const src = readFileSync(SRC, "utf-8");

/** 닫아 둔 기능의 깃발 — `gate: "comic"` 액션은 이것이 `true` 일 때만 싣는다 (`src/editor/comic.ts` 의 `COMIC_READY`) */
const flag = /export const COMIC_READY = (true|false);/.exec(readFileSync(join(here, "..", "src", "editor", "comic.ts"), "utf-8"));
if (!flag) {
  console.error("[gen-actions] src/editor/comic.ts 에서 COMIC_READY 줄을 못 찾았습니다.");
  process.exit(1);
}
const open = { comic: flag[1] === "true" };

/** `defineAction({ ... });` 덩이를 통째로 자른다 — 중괄호 깊이로 끝을 찾는다 */
function blocks(text) {
  const out = [];
  const re = /defineAction\(\{/g;
  let m;
  while ((m = re.exec(text))) {
    let i = m.index + m[0].length - 1; // `{` 자리
    let depth = 0;
    for (; i < text.length; i++) {
      if (text[i] === "{") depth++;
      else if (text[i] === "}") {
        depth--;
        if (depth === 0) break;
      }
    }
    out.push(text.slice(m.index + m[0].length - 1, i + 1));
  }
  return out;
}

/** `id: "..."` 처럼 따옴표 문자열 하나 */
const str = (b, key) => {
  const m = new RegExp(`\\b${key}:\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(b);
  return m ? m[1].replace(/\\"/g, '"') : null;
};

/** `desc:` 는 `+` 로 이어 붙인 여러 줄일 수 있다 */
function desc(b) {
  const at = b.indexOf("desc:");
  if (at < 0) return "";
  const tail = b.slice(at + 5);
  // 다음 최상위 키(`args:`·`confirm:`·`preview:`·`run:`) 앞까지
  const end = tail.search(/\n\s{2}(args|confirm|preview|run):/);
  const body = end < 0 ? tail : tail.slice(0, end);
  const parts = [...body.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((x) => x[1]);
  return parts.join("").replace(/\\"/g, '"').replace(/\s+/g, " ").trim();
}

/** `args: { name: { type: "...", desc: "...", required: true } }` */
function args(b) {
  const at = b.indexOf("args:");
  if (at < 0) return {};
  const open = b.indexOf("{", at);
  let depth = 0, i = open;
  for (; i < b.length; i++) {
    if (b[i] === "{") depth++;
    else if (b[i] === "}") {
      depth--;
      if (depth === 0) break;
    }
  }
  const body = b.slice(open + 1, i);
  const out = {};
  // 인자 하나 = `이름: { ... }`
  const re = /(\w+):\s*\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/g;
  let m;
  while ((m = re.exec(body))) {
    const [, name, inner] = m;
    const type = str(inner, "type") ?? "string";
    const d = str(inner, "desc") ?? "";
    const row = { type, desc: d };
    const items = /items:\s*\{\s*type:\s*"(\w+)"/.exec(inner);
    if (items) row.items = { type: items[1] };
    if (/required:\s*true/.test(inner)) row.required = true;
    out[name] = row;
  }
  return out;
}

const actions = [];
const closed = [];
for (const b of blocks(src)) {
  const id = str(b, "id");
  if (!id) continue;
  const gate = str(b, "gate");
  if (gate && !open[gate]) {
    closed.push(id);
    continue;
  }
  actions.push({ id, desc: desc(b), args: args(b) });
}

if (!actions.length) {
  console.error("[gen-actions] 액션을 하나도 못 찾았습니다 — 정규식이 소스와 어긋났습니다.");
  process.exit(1);
}

writeFileSync(OUT, JSON.stringify({ actions }, null, 2) + "\n", "utf-8");
console.log(`[gen-actions] ${actions.length}개 → ${OUT}${closed.length ? ` (닫아 둔 기능이라 뺌: ${closed.join(", ")})` : ""}`);
for (const a of actions) console.log(`  ${a.id}(${Object.keys(a.args).join(", ")})`);
