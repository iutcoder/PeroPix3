# PeroPix for macOS

macOS 우선 독립 포크입니다. 원본: https://github.com/mrm987/PeroPix3
배포: https://github.com/iutcoder/PeroPix3/releases

## 설치

Apple Silicon Mac용입니다. Intel Mac용 빌드는 제공하지 않습니다.
DMG를 열고 PeroPix.app을 Applications로 복사하거나 ZIP을 풀어 앱을 옮기세요.
Python과 검열 모델은 앱에 포함되어 있습니다.

현재 배포물은 ad-hoc 서명되어 있으며 Apple Developer ID 서명 및 공증은 없습니다.
macOS Gatekeeper가 실행을 제한할 수 있습니다. 파일 출처를 확인한 뒤
시스템 설정의 개인정보 보호 및 보안에서 macOS가 제공하는 실행 허용 절차를 따르세요.

## 기존 버전에서 업그레이드

앱을 종료한 뒤 다음 폴더 전체를 별도 위치에 복사해 백업하세요:

    ~/Library/Application Support/io.github.iutcoder.peropix3

이전 버전의 기록은 새 버전 시작 시 DB로 마이그레이션될 수 있습니다.
되돌릴 때는 이전 앱과 해당 버전에서 백업한 데이터를 함께 사용하세요.
앱 번들을 교체해도 사용자 데이터는 별도 폴더에 유지됩니다.
로그: 위 폴더 아래 logs/peropix.log.

원본 Windows 포터블 앱 자동 업데이트는 사용하지 않습니다.
새 앱은 이 포크의 macOS 릴리스에서 수동으로 받습니다.
만화 글꼴 다운로드와 사용자가 선택하는 플러그인 설치는 별도 기능입니다.

## 빌드

Apple Silicon macOS, Node.js/npm, Rust, Xcode Command Line Tools가 필요합니다.

    npm ci
    npm run build
    bash scripts/prepare-macos-python.sh
    cargo test --locked --manifest-path src-tauri/Cargo.toml --target aarch64-apple-darwin
    PYTHONDONTWRITEBYTECODE=1 src-tauri/python/bin/python3 scripts/test-macos-smoke.py
    npx tauri build --target aarch64-apple-darwin --bundles app

배포 전에 앱 전체에 ad-hoc 또는 Developer ID 서명을 적용하고 codesign으로 검증해야 합니다.
서명 후에는 앱 내부 파일을 변경하지 마세요.

master는 원본 동기화용, macos-port-dev는 통합·검증용,
macos-port는 검증된 macOS 배포용입니다.
