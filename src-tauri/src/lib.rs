mod backend;

use std::sync::Mutex;
use std::sync::OnceLock;
use std::time::Instant;
use tauri::{Manager, RunEvent};

/// 이 프로세스가 시작한 순간. ★부팅이 어디서 오래 걸리는지 재는 자 (`uptime_ms`).
static START: OnceLock<Instant> = OnceLock::new();

/// 껍데기가 켜진 뒤 흐른 시간(ms). ★화면이 **자기가 언제 처음 돌았는지**를 알기 위한 값이다 —
/// 창을 만들고 웹뷰가 문서를 받아 번들을 돌리기까지가 여기 다 들어 있다. 그 구간은 화면
/// 스스로는 잴 수 없다 (`performance.timeOrigin` 은 문서가 생긴 뒤부터다).
#[tauri::command]
fn uptime_ms() -> u128 {
    START.get().map(|t| t.elapsed().as_millis()).unwrap_or(0)
}

/// 프론트가 백엔드 주소를 알아내는 유일한 창구.
/// 포트를 프론트에 하드코딩하지 않는다 — 포트는 이제 인스턴스마다 다르다(`backend_port`).
///
/// ★★**이번 실행의 열쇠가 주소 앞머리로 붙는다** (`/k/<열쇠>`, 2026-08-26). 화면이 쓰는
///   주소는 전부 이 값에 경로를 이어 붙여 만들어지므로, 여기 한 번 붙이면 그림 태그와
///   웹소켓까지 함께 덮인다 — 왜 필요한지는 `backend::backend_key` 의 ★★주에 있다.
#[tauri::command]
fn backend_url() -> String {
    let key = backend::backend_key();
    let base = format!("http://127.0.0.1:{}", backend::backend_port());
    if key.is_empty() { base } else { format!("{base}/k/{key}") }
}

/// 이 앱이 서 있는 자리. ★화면이 **「지금 붙은 백엔드가 내 것인가」**를 묻는 데 쓴다 —
/// 백엔드도 같은 값을 알려 주므로(`/api/health` 의 `root`), 둘이 다르면 남의 것에 붙은 것이다.
#[tauri::command]
fn app_root() -> String {
    backend::root().to_string_lossy().to_string()
}

struct InstanceLock {
    _file: std::sync::Mutex<Option<std::fs::File>>,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    /* ★★**같은 폴더를 두 번 열지 않는다** (사용자 지시 2026-08-26). 같은 `workspaces/` 를
         두 창이 만지면 나중에 저장하는 쪽이 상대의 편집을 덮는다. 다른 폴더의 두 벌은
         그대로 허용한다 — 포터블은 그러라고 있는 형식이다 (`backend::lock_app_dir` 의 ★주). */
    let _ = START.set(Instant::now());
    let Some(lock) = backend::lock_app_dir() else {
        eprintln!("[app] 이 폴더의 PeroPix 가 이미 실행 중입니다 — 창을 안 띄웁니다");
        return;
    };
    // 자물쇠는 앱이 끝날 때까지 들고 있어야 한다. 핸들을 닫으면 잠금이 풀린다.
    let lock = std::sync::Mutex::new(Some(lock));

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![backend_url, app_root, uptime_ms])
        .setup(move |app| {
            app.manage(InstanceLock { _file: lock });
            /* ★★**웹뷰 바탕을 어둡게 깔아 둔다** (사용자 지적 2026-08-27: *"처음에 흰 화면이
                 한참 뜨다가"*). `index.html` 이 첫 페인트부터 스플래시를 그리지만, 그보다
                 **앞선 순간** — 창은 떴고 웹뷰가 아직 문서를 안 받은 때 — 에는 웹뷰의 기본
                 바탕인 **흰색**이 그대로 보인다. 그 한 겹을 여기서 덮는다.
               ★색은 `styles/tokens.css` 의 어두운 `--bg`(#16161a)다. 밝은 테마를 쓰는 사람에게는
                 잠깐 어두웠다 밝아지는데, **흰 번쩍임보다 눈에 덜 거슬린다** (어두운 쪽이
                 기본이고 대부분 그걸 쓴다).
               ★설정 파일로는 못 준다 — `tauri.conf.json` 의 창 스키마에 그 열쇠가 없다. */
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.set_background_color(Some(tauri::window::Color(0x16, 0x16, 0x1a, 0xff)));
            }
            match backend::spawn() {
                Ok(child) => {
                    app.manage(backend::Backend(Mutex::new(Some(child))));
                    backend::log_line(&format!("[backend] spawned on port {}", backend::backend_port()));
                }
                Err(e) => {
                    // 백엔드가 안 떠도 창은 띄운다 — 프론트가 상태를 표시하고 로그를 안내한다.
                    backend::log_line(&format!("[backend] spawn failed: {e}"));
                    app.manage(backend::Backend(Mutex::new(None)));
                }
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    // ★사이드카는 종료 이벤트에서 명시적으로 내린다.
    //   Drop 에만 맡기면 강제 종료·process::exit 경로에서 실행되지 않아
    //   백엔드가 고아로 남는다 (v2.x 에서 "브라우저를 닫아도 서버가 남던" 문제와 같은 부류).
    app.run(|app_handle, event| match event {
        RunEvent::ExitRequested { .. } | RunEvent::Exit => {
            if let Some(state) = app_handle.try_state::<backend::Backend>() {
                state.kill();
            }
        }
        _ => {}
    });
}
