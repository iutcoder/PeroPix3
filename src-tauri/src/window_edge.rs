//! 창 가장자리 — **커서가 바뀌는 자리와 누름이 먹는 자리를 하나로** 한다.
//!
//! ★★사용자 지적 2026-08-28: *"커서가 리사이즈 모양으로 변하는 구간이 100이면 아래 50%
//!   정도에서만 더블클릭이 먹는다."* · *"커서 판정이랑 동일하게 일치시켜야 할 듯."*
//!
//! 그 위쪽 절반의 주인을 `WindowFromPoint` 로 물어 **이름을 받았다**(실측 2026-08-28):
//!
//! ```text
//! 맨위+0  주인 = TAURI_DRAG_RESIZE_BORDERS   판정=12(HTTOP)
//! 맨위+2  주인 = TAURI_DRAG_RESIZE_BORDERS   판정=12
//! 맨위+4  주인 = Chrome_RenderWidgetHostHWND  판정=1(HTCLIENT)
//! ```
//!
//! **Tauri 가 스스로 깔아 두는 투명 덧창**이다 (`tauri-runtime-wry` 의 `undecorated_resizing.rs`).
//! `decorations:false` 이고 크기 조절이 되는 창에 붙어, 클라이언트 안쪽 가장자리 `SM_CXFRAME`
//! (배율 1 에서 4px) 너비의 띠만 남기고 가운데를 도려낸 자식창이다. 그 띠에서:
//!   · `WM_NCHITTEST` 에 `HTTOP` 등을 돌려주므로 **커서가 크기 조절 모양으로 바뀌고**,
//!   · `WM_NCLBUTTONDOWN` 을 받으면 부모에게 같은 것을 부쳐 **OS 크기 조절을 시작**한다.
//!   · 더블클릭은 아무것도 안 한다 (클래스에 `CS_DBLCLKS` 도 없다).
//! 화면(웹뷰)은 그 띠 밑에 있어 **누름을 아예 못 본다.** 그래서 우리가 그린 8px 손잡이 중
//! 위쪽 4px 은 커서만 바뀌고 더블클릭이 죽어 있었고, 거기서 시작한 끌기는 우리 손을 안 거쳐
//! 「늘린 것을 되돌리기」(`lib/window` 의 `unfitFor`)도 건너뛰었다. 같은 뿌리의 한 증상이다.
//!
//! ★★그래서 **그 덧창을 걷어낸다.** 가장자리는 화면의 손잡이 하나가 맡는다 — 커서도 누름도
//!   더블클릭도 같은 요소가 받으므로 어긋날 자리가 없다. 끌어서 크기를 바꾸는 것은 지금까지처럼
//!   `startResizeDragging` 이 OS 에 넘긴다 (화면 끝에 붙였을 때의 스냅도 그대로다).
//! ★Tauri 는 이미 있으면 다시 만들지 않는다(`attach_resize_handler` 의 `FindWindowExW` 검사) —
//!   없앤 뒤 되살아나는 길은 `set_decorations`·`set_shadow` 를 다시 부르는 것뿐인데, 이 앱은
//!   둘 다 안 부른다.
//! ★같은 프로세스·같은 스레드의 창이라 `DestroyWindow` 로 바로 없앨 수 있다.
//!
//! ~~한때 여기에 「tao 가 돌려주는 `HTTOP` 을 `HTCLIENT` 로 바꾸는 후크」가 있었다~~ — 그 판정은
//! 웹뷰 자식창이 창을 통째로 덮고 있어 부모에게 **아예 오지 않는다**(로그 0회). 죽은 코드라 걷었다.

/// Tauri 의 크기 조절 덧창을 없앤다. 있었으면 `true`.
#[cfg(windows)]
pub fn drop_tauri_resize_overlay(hwnd: *mut core::ffi::c_void) -> bool {
    use windows_sys::Win32::Foundation::HWND;
    use windows_sys::Win32::UI::WindowsAndMessaging::{DestroyWindow, FindWindowExW};

    // 이름은 `tauri-runtime-wry/src/undecorated_resizing.rs` 의 상수 그대로다
    let class: Vec<u16> = "TAURI_DRAG_RESIZE_BORDERS\0".encode_utf16().collect();
    let name: Vec<u16> = "TAURI_DRAG_RESIZE_WINDOW\0".encode_utf16().collect();
    unsafe {
        let child = FindWindowExW(hwnd as HWND, std::ptr::null_mut(), class.as_ptr(), name.as_ptr());
        if child.is_null() {
            return false;
        }
        DestroyWindow(child) != 0
    }
}

#[cfg(not(windows))]
pub fn drop_tauri_resize_overlay(_hwnd: *mut core::ffi::c_void) -> bool {
    false
}


/// ★★**최대화 창을 커서 아래로 한 번에 복원하고 끌기를 시작한다** (사용자 지적 2026-09-07: *"전체 최대를 하고
/// 헤더를 드래그할 때 커서랑 헤더가 잠깐 불일치했다가 돌아와서 앱이 튀듯이 움직임"*).
///
/// 화면에서 `unmaximize → setPosition → startDragging` 을 차례로 부르면 IPC 세 번 사이에 창이 **옛 자리에
/// 복원된 채 한두 프레임 보이고** 커서 아래로 뛴다. 여기서는 `SetWindowPlacement` 으로 복원 사각형을 먼저
/// 커서 아래로 잡고 같은 호출로 복원하므로 중간 상태가 없다. 이어서 tao 의 `drag_window` 와 같은 메시지
/// (`WM_NCLBUTTONDOWN`·`HTCAPTION`)를 부쳐 OS 이동 루프에 넣는다.
///
/// `ratio_x` 는 커서가 제목줄에서 차지하던 가로 비율, `offset_y` 는 제목줄 위에서의 세로 위치(물리 픽셀).
/// ★`rcNormalPosition` 은 **작업 영역 좌표**라(문서), 커서가 있는 모니터의 작업 영역 원점을 뺀다.
#[cfg(windows)]
pub fn drag_restore(hwnd: *mut core::ffi::c_void, ratio_x: f64, offset_y: i32) -> Result<(), String> {
    use windows_sys::Win32::Foundation::{HWND, POINT, RECT};
    use windows_sys::Win32::Graphics::Gdi::{GetMonitorInfoW, MonitorFromPoint, MONITORINFO, MONITOR_DEFAULTTONEAREST};
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::ReleaseCapture;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetCursorPos, GetWindowPlacement, PostMessageW, SetWindowPlacement, HTCAPTION, SW_SHOWNORMAL,
        WINDOWPLACEMENT, WM_NCLBUTTONDOWN,
    };
    let hwnd = hwnd as HWND;
    unsafe {
        let mut pt = POINT { x: 0, y: 0 };
        if GetCursorPos(&mut pt) == 0 {
            return Err("GetCursorPos 실패".into());
        }
        let mut wp: WINDOWPLACEMENT = std::mem::zeroed();
        wp.length = std::mem::size_of::<WINDOWPLACEMENT>() as u32;
        if GetWindowPlacement(hwnd, &mut wp) == 0 {
            return Err("GetWindowPlacement 실패".into());
        }
        let w = wp.rcNormalPosition.right - wp.rcNormalPosition.left;
        let h = wp.rcNormalPosition.bottom - wp.rcNormalPosition.top;
        // 작업 영역 원점 — 커서가 있는 모니터 기준
        let mon = MonitorFromPoint(pt, MONITOR_DEFAULTTONEAREST);
        let mut mi: MONITORINFO = std::mem::zeroed();
        mi.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
        let (ox, oy) = if !mon.is_null() && GetMonitorInfoW(mon, &mut mi) != 0 {
            (mi.rcWork.left, mi.rcWork.top)
        } else {
            (0, 0)
        };
        let left = pt.x - (ratio_x * w as f64).round() as i32 - ox;
        let top = pt.y - offset_y - oy;
        wp.rcNormalPosition = RECT { left, top, right: left + w, bottom: top + h };
        wp.showCmd = SW_SHOWNORMAL as u32;
        if SetWindowPlacement(hwnd, &wp) == 0 {
            return Err("SetWindowPlacement 실패".into());
        }
        ReleaseCapture();
        let lparam = ((pt.y as isize) << 16) | (pt.x as isize & 0xffff);
        PostMessageW(hwnd, WM_NCLBUTTONDOWN, HTCAPTION as usize, lparam);
    }
    Ok(())
}

#[cfg(not(windows))]
pub fn drag_restore(_hwnd: *mut core::ffi::c_void, _ratio_x: f64, _offset_y: i32) -> Result<(), String> {
    Err("윈도우에서만".into())
}
