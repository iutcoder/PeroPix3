mod backend;
mod winstate;

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
/// ★★**포트는 파이썬이 알려 온 것이다** (2026-09-29, `backend::wanted_port` 의 ★★주). 알려 올 때까지
///   기다리므로 명령 스레드를 붙잡지 않게 따로 돌린다.
#[tauri::command]
async fn backend_url() -> String {
    let key = backend::backend_key();
    let port = tauri::async_runtime::spawn_blocking(backend::backend_port)
        .await
        .unwrap_or(backend::DEFAULT_PORT);
    let base = format!("http://127.0.0.1:{port}");
    if key.is_empty() { base } else { format!("{base}/k/{key}") }
}

/// 원본의 Windows 전용 원자적 창 복원 명령과 프론트엔드 호출 규약을 맞춘다.
/// macOS에서는 오류를 돌려 프론트엔드가 기존 Tauri 창 이동 경로를 사용하게 한다.
#[tauri::command]
fn drag_restore(window: tauri::WebviewWindow, ratio_x: f64, offset_y: f64) -> Result<(), String> {
    let _ = (window, ratio_x, offset_y);
    Err("Windows 전용 창 복원 명령입니다".into())
}

/// 창 크기·자리를 적어 둔다 — **화면이 부른다** (`WindowFrame` 의 크기 사건, 300ms 디바운스).
/// 켤 때 그대로 되살린다 (`winstate` 머리 주석 · `run` 의 setup).
#[tauri::command]
fn note_window(x: i32, y: i32, w: u32, h: u32, maximized: bool) {
    let s = winstate::WinState { x, y, w, h, maximized };
    if let Err(e) = winstate::save(&backend::root(), &s) {
        backend::log_line(&format!("[window] 창 자리를 못 적었습니다: {e}"));
    }
}

/// 이 앱이 서 있는 자리. ★화면이 **「지금 붙은 백엔드가 내 것인가」**를 묻는 데 쓴다 —
/// 백엔드도 같은 값을 알려 주므로(`/api/health` 의 `root`), 둘이 다르면 남의 것에 붙은 것이다.
#[tauri::command]
fn app_root() -> String {
    backend::root().to_string_lossy().to_string()
}

#[tauri::command]
fn restart_backend(app: tauri::AppHandle) -> Result<(), String> {
    let state = app.try_state::<backend::Backend>().ok_or("백엔드 상태가 없습니다")?;
    state.kill();
    let child = backend::spawn().map_err(|e| format!("백엔드를 다시 띄우지 못했습니다: {e}"))?;
    backend::log_line(&format!("[backend] respawned, asking port {}", backend::wanted_port().0));
    if let Ok(mut g) = state.0.lock() {
        *g = Some(child);
    }
    Ok(())
}

/// **그냥 다시 켠다** — 앱 전체를. `apply_update` 의
/// 뒷부분과 같은 차례(사이드카 내림 → 자물쇠 놓음 → 새 판 띄움 → 나감)인데 갈아 끼우는 것이 없다.
/// ★`update::relaunch` 를 쓰지 않는다 — 그쪽은 뿌리의 `PeroPix.exe` 를 띄우는데, 개발 중(`tauri dev`)에는
///   exe 가 `target/debug/` 에 있어 뿌리에 없다. **지금 도는 그 exe** 를 그대로 띄운다.
#[tauri::command]
fn restart_app(app: tauri::AppHandle) -> Result<(), String> {
    let root = backend::root();
    if let Some(state) = app.try_state::<backend::Backend>() {
        state.kill();
    }
    if let Some(l) = app.try_state::<InstanceLock>() {
        if let Ok(mut g) = l._file.lock() {
            g.take();
        }
    }
    let exe = std::env::current_exe().map_err(|e| format!("실행 파일을 못 찾았습니다: {e}"))?;
    let mut cmd = std::process::Command::new(exe);
    cmd.current_dir(&root);
    cmd.spawn().map_err(|e| format!("다시 켜지 못했습니다: {e}"))?;
    app.exit(0);
    Ok(())
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
        .invoke_handler(tauri::generate_handler![backend_url, app_root, uptime_ms, drag_restore, note_window, restart_backend, restart_app])
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
                /* ★★**마지막에 맞춰 둔 크기·자리로 띄운다** (사용자 지시 2026-09-14: *"재실행할 때마다
                     창 크기가 고정 같은데, 마지막에 조정했던 크기로 복원해 줘"*). 설정의 1440×900 은
                     **처음 켤 때의 값**이 된다.
                   ★★**보이기 전에** 맞춘다 — `tauri.conf.json` 에서 `visible: false` 로 만들어 두고 여기서
                     맞춘 뒤 띄운다. 뜬 뒤에 맞추면 기본 크기가 한 번 번쩍이고 줄어든다.
                   ★★**어떤 길로 가도 창은 뜬다** — 아래 `show()` 는 되살리기가 실패하든 말든 돈다.
                     여기서 일찍 돌아가면 창이 영영 안 보이는 앱이 된다.
                   ★적어 둔 자리가 지금 화면 밖이면 **자리만** 버리고 크기는 쓴다 (`on_screen`). */
                if let Some(st) = winstate::load(&backend::root()) {
                    let _ = w.set_size(tauri::PhysicalSize::new(st.w, st.h));
                    if winstate::on_screen(&w, &st) {
                        let _ = w.set_position(tauri::PhysicalPosition::new(st.x, st.y));
                    } else {
                        backend::log_line("[window] 적어 둔 자리가 화면 밖이라 가운데로 띄웁니다");
                        let _ = w.center();
                    }
                    if st.maximized {
                        let _ = w.maximize();
                    }
                }
                let _ = w.show();
            }
            match backend::spawn() {
                Ok(child) => {
                    app.manage(backend::Backend(Mutex::new(Some(child))));
                    backend::log_line(&format!("[backend] spawned, asking port {}", backend::wanted_port().0));
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
