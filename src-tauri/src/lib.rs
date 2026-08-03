use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Url, WebviewUrl, WebviewWindowBuilder};

const USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const LOGIN_WINDOW: &str = "naver-login";
const LOGIN_URL: &str =
    "https://nid.naver.com/nidlogin.login?url=https%3A%2F%2Fchzzk.naver.com%2F";
/// 창을 연 뒤 이만큼(초)은 남아 있던 쿠키를 로그인으로 보지 않는다.
/// 이 시간이 지나야 성공 판정을 하므로, 창이 열리자마자 닫히지 않는다.
const LOGIN_WARMUP_SECS: u32 = 3;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct NaverCookies {
    nid_aut: String,
    nid_ses: String,
}

/// 쿠키가 실제로 로그인된 치지직 세션인지 확인한다.
/// 2차 인증 진행 중에도 중간 단계의 NID 쿠키가 생길 수 있어서,
/// 쿠키 존재만으로 로그인 성공을 판정하면 미완성 세션을 저장하게 된다.
/// Ok(()) = 로그인 확인됨, Err(사유) = 아직 아님 (사유는 진단 메시지로 노출)
async fn verify_chzzk_login(nid_aut: &str, nid_ses: &str) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .build()
        .map_err(|e| format!("HTTP 클라이언트 생성 실패: {e}"))?;
    let res = client
        .get("https://comm-api.game.naver.com/nng_main/v1/user/getUserStatus")
        .header("Accept", "application/json")
        .header("Referer", "https://chzzk.naver.com/")
        .header("Cookie", format!("NID_AUT={nid_aut}; NID_SES={nid_ses}"))
        .send()
        .await
        .map_err(|e| format!("요청 실패: {e}"))?;

    let status = res.status().as_u16();
    let body = res.text().await.map_err(|e| format!("응답 읽기 실패: {e}"))?;
    if status >= 400 {
        let snippet: String = body.chars().take(120).collect();
        return Err(format!("HTTP {status}: {snippet}"));
    }
    let json = serde_json::from_str::<serde_json::Value>(&body).map_err(|_| {
        let snippet: String = body.chars().take(120).collect();
        format!("JSON 아님: {snippet}")
    })?;

    let logged_in = json
        .pointer("/content/loggedIn")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);
    let has_user = json
        .pointer("/content/userIdHash")
        .and_then(|v| v.as_str())
        .is_some_and(|s| !s.is_empty());
    if logged_in && has_user {
        Ok(())
    } else {
        let snippet: String = body.chars().take(120).collect();
        Err(format!("아직 로그인 상태가 아님: {snippet}"))
    }
}

/// 네이버 공식 로그인 페이지를 별도 창으로 열고, 로그인이 완료되어
/// NID_AUT / NID_SES 쿠키가 생기면 "naver-login-success" 이벤트로 전달한다.
/// 쿠키는 치지직 API로 실제 로그인 세션인지 검증한 뒤에만 성공 처리한다
/// (2차 인증이 끝날 때까지 로그인 창이 유지됨).
/// 비밀번호는 네이버 페이지에만 입력되며 앱은 세션 쿠키만 읽는다.
#[tauri::command]
async fn naver_login(app: AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window(LOGIN_WINDOW) {
        let _ = w.set_focus();
        return Ok(());
    }
    let url: Url = LOGIN_URL.parse().map_err(|e: url::ParseError| e.to_string())?;
    let win = WebviewWindowBuilder::new(&app, LOGIN_WINDOW, WebviewUrl::External(url))
        .title("네이버 로그인")
        .inner_size(520.0, 720.0)
        .center()
        .visible(true)
        .focused(true)
        .build()
        .map_err(|e| format!("로그인 창 생성 실패: {e}"))?;
    // 창을 확실히 앞으로 (다른 창 뒤에 열려 안 보이는 경우 방지)
    let _ = win.show();
    let _ = win.unminimize();
    let _ = win.set_focus();
    let _ = app.emit(
        "naver-login-progress",
        "로그인 창을 열었습니다. 네이버 계정으로 로그인해 주세요.".to_string(),
    );

    tauri::async_runtime::spawn(async move {
        // 검증에 실패한 쿠키 값. 서버 쪽에서 세션이 완성되면 쿠키 값이
        // 그대로여도 유효해질 수 있으므로, 같은 값이라도 주기적으로 재검증한다.
        let mut rejected: Option<(String, String)> = None;
        let mut ticks: u32 = 0;
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
            ticks += 1;
            let Some(win) = app.get_webview_window(LOGIN_WINDOW) else {
                let _ = app.emit("naver-login-cancelled", ());
                break;
            };

            // 창이 열리자마자 닫히지 않도록, 처음 몇 초는 판정하지 않는다.
            // 그동안 창이 실제로 보이는지도 확인해, 안 보이면 다시 띄우고
            // 화면 밖에 놓였으면 안쪽으로 끌어온다.
            if ticks <= LOGIN_WARMUP_SECS {
                if ticks == 2 {
                    // 창 상태 조회는 메인 스레드를 기다리므로 블로킹 스레드에서 한다
                    let w = win.clone();
                    let checked = tauri::async_runtime::spawn_blocking(move || {
                        let visible = w.is_visible().unwrap_or(false);
                        if !visible {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                        // 모니터 밖에 놓였으면 안쪽으로 끌어온다
                        let off_screen = w
                            .outer_position()
                            .map(|p| {
                                p.x < -2000 || p.y < -2000 || p.x > 20000 || p.y > 20000
                            })
                            .unwrap_or(false);
                        if off_screen {
                            let _ =
                                w.set_position(tauri::PhysicalPosition::new(120i32, 80i32));
                        }
                        (visible, off_screen)
                    })
                    .await;
                    if let Ok((visible, off_screen)) = checked {
                        let _ = app.emit(
                            "naver-login-progress",
                            format!(
                                "로그인 창 상태: {}{}",
                                if visible {
                                    "표시됨"
                                } else {
                                    "숨겨져 있어 다시 띄웠습니다"
                                },
                                if off_screen {
                                    " · 화면 밖이라 안쪽으로 옮겼습니다"
                                } else {
                                    ""
                                },
                            ),
                        );
                    }
                }
                continue;
            }

            // Windows에서는 동기 컨텍스트에서 쿠키를 읽으면 데드락이 발생하므로
            // 블로킹 스레드에서 읽는다.
            let read = tauri::async_runtime::spawn_blocking(move || read_nid_cookies(&win)).await;
            let Ok((nid_aut, nid_ses, total)) = read else {
                continue;
            };

            let Some(pair) = nid_aut.zip(nid_ses) else {
                // 10초마다 진행 상황 보고 (쿠키가 안 잡히는 경우 진단용)
                if ticks % 10 == 0 {
                    let _ = app.emit(
                        "naver-login-progress",
                        format!("로그인 대기 중… (쿠키 {total}개 확인, NID 세션 아직 없음)"),
                    );
                }
                continue;
            };

            // 같은 쿠키는 5초 간격으로만 재검증 (API 남용 방지)
            if rejected.as_ref() == Some(&pair) && ticks % 5 != 0 {
                continue;
            }
            match verify_chzzk_login(&pair.0, &pair.1).await {
                Ok(()) => {
                    // 창을 열자마자 성공했다면 이미 로그인되어 있던 것이므로 알려 준다
                    if ticks <= LOGIN_WARMUP_SECS + 2 {
                        let _ = app.emit(
                            "naver-login-progress",
                            "이미 네이버에 로그인되어 있어 바로 완료했습니다. \
                             다른 계정으로 바꾸려면 먼저 «네이버 로그아웃»을 눌러 주세요."
                                .to_string(),
                        );
                    }
                    let _ = app.emit(
                        "naver-login-success",
                        NaverCookies { nid_aut: pair.0, nid_ses: pair.1 },
                    );
                    if let Some(w) = app.get_webview_window(LOGIN_WINDOW) {
                        let _ = w.close();
                    }
                    break;
                }
                Err(reason) => {
                    if rejected.as_ref() != Some(&pair) {
                        let _ = app.emit(
                            "naver-login-progress",
                            format!("네이버 세션은 찾았지만 치지직 인증 확인에 실패했습니다 — {reason}"),
                        );
                    }
                    rejected = Some(pair);
                }
            }
        }
    });
    Ok(())
}

/// 로그인 창에서 NID_AUT / NID_SES 쿠키를 찾는다.
/// 웹뷰 구현에 따라 전체 쿠키 조회가 비어 올 수 있어, 네이버 계열 URL별
/// 조회까지 함께 시도한다. 반환값은 (NID_AUT, NID_SES, 확인한 쿠키 수).
fn read_nid_cookies(win: &tauri::WebviewWindow) -> (Option<String>, Option<String>, usize) {
    // 쿠키 타입을 직접 명명하지 않고 모두 한 곳에 모은 뒤 훑는다
    // (tauri가 Cookie 타입을 공개 경로로 노출하지 않음)
    let mut all = win.cookies().unwrap_or_default();
    for url in [
        "https://chzzk.naver.com/",
        "https://nid.naver.com/",
        "https://www.naver.com/",
        "https://naver.com/",
    ] {
        if let Ok(parsed) = url.parse::<Url>() {
            if let Ok(cookies) = win.cookies_for_url(parsed) {
                all.extend(cookies);
            }
        }
    }

    let total = all.len();
    let mut nid_aut = None;
    let mut nid_ses = None;
    for c in all {
        match c.name() {
            "NID_AUT" if !c.value().is_empty() => nid_aut = Some(c.value().to_string()),
            "NID_SES" if !c.value().is_empty() => nid_ses = Some(c.value().to_string()),
            _ => {}
        }
    }
    (nid_aut, nid_ses, total)
}

/// 치지직 API GET 요청을 Rust에서 직접 수행한다.
/// 웹뷰 fetch는 User-Agent/Cookie 헤더를 스펙상 강제 제거하기 때문에
/// (치지직은 브라우저 UA 없는 요청을 403으로 차단) 여기서 보내야 한다.
#[tauri::command]
async fn chzzk_get(url: String, cookie: Option<String>) -> Result<String, String> {
    let parsed: Url = url.parse().map_err(|e: url::ParseError| e.to_string())?;
    let host = parsed.host_str().unwrap_or_default();
    if !matches!(host, "api.chzzk.naver.com" | "comm-api.game.naver.com") {
        return Err(format!("허용되지 않은 호스트: {host}"));
    }

    let client = reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .build()
        .map_err(|e| e.to_string())?;
    let mut req = client
        .get(parsed)
        .header("Accept", "application/json")
        .header("Referer", "https://chzzk.naver.com/");
    if let Some(cookie) = cookie {
        req = req.header("Cookie", cookie);
    }

    let res = req.send().await.map_err(|e| e.to_string())?;
    let status = res.status().as_u16();
    let body = res.text().await.map_err(|e| e.to_string())?;
    if status >= 400 {
        let snippet: String = body.chars().take(300).collect();
        return Err(format!("HTTP {status}: {snippet}"));
    }
    Ok(body)
}

/// 로그 저장 기준 폴더: 사용자가 지정한 경로가 있으면 그 경로,
/// 없으면 <앱 데이터>/logs
fn resolve_log_base(
    app: &AppHandle,
    base_dir: &Option<String>,
) -> Result<std::path::PathBuf, String> {
    match base_dir.as_deref().map(str::trim) {
        Some(dir) if !dir.is_empty() => Ok(std::path::PathBuf::from(dir)),
        _ => Ok(app
            .path()
            .app_data_dir()
            .map_err(|e| e.to_string())?
            .join("logs")),
    }
}

/// 기본 로그 폴더 경로 (설정 UI 표시용)
#[tauri::command]
async fn get_default_log_dir(app: AppHandle) -> Result<String, String> {
    Ok(resolve_log_base(&app, &None)?.to_string_lossy().into_owned())
}

/// 로그 폴더를 OS 파일 탐색기로 연다.
#[tauri::command]
async fn open_log_dir(app: AppHandle, base_dir: Option<String>) -> Result<(), String> {
    let dir = resolve_log_base(&app, &base_dir)?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    #[cfg(target_os = "windows")]
    let opener = "explorer";
    #[cfg(target_os = "macos")]
    let opener = "open";
    #[cfg(all(unix, not(target_os = "macos")))]
    let opener = "xdg-open";
    std::process::Command::new(opener)
        .arg(&dir)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// tauri-plugin-sql이 상대 경로를 붙이는 기준 폴더 (기본 DB 위치)
fn default_db_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(app
        .path()
        .app_config_dir()
        .map_err(|e| e.to_string())?
        .join("chzzk.db"))
}

#[tauri::command]
async fn get_default_db_path(app: AppHandle) -> Result<String, String> {
    Ok(default_db_path(&app)?.to_string_lossy().into_owned())
}

/// DB를 둘 폴더를 준비한다.
/// 새 위치에 파일이 없고 지금 쓰는 DB가 있으면 그대로 복사해 기록을 이어간다.
/// 반환값은 앞으로 열어야 할 DB 파일 경로.
#[tauri::command]
async fn prepare_db_dir(
    app: AppHandle,
    dir: Option<String>,
    current: Option<String>,
) -> Result<String, String> {
    let target = match dir.as_deref().map(str::trim) {
        Some(d) if !d.is_empty() => {
            std::fs::create_dir_all(d).map_err(|e| e.to_string())?;
            std::path::PathBuf::from(d).join("chzzk.db")
        }
        _ => default_db_path(&app)?,
    };

    let from = match current.as_deref().map(str::trim) {
        Some(c) if !c.is_empty() => std::path::PathBuf::from(c),
        _ => default_db_path(&app)?,
    };
    if from != target && from.exists() && !target.exists() {
        std::fs::copy(&from, &target).map_err(|e| format!("DB 복사 실패: {e}"))?;
    }
    Ok(target.to_string_lossy().into_owned())
}

/// 폴더를 OS 파일 탐색기로 연다.
#[tauri::command]
async fn open_dir(path: String) -> Result<(), String> {
    let dir = std::path::PathBuf::from(&path);
    let dir = if dir.is_file() {
        dir.parent().map(|p| p.to_path_buf()).unwrap_or(dir)
    } else {
        dir
    };
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    #[cfg(target_os = "windows")]
    let opener = "explorer";
    #[cfg(target_os = "macos")]
    let opener = "open";
    #[cfg(all(unix, not(target_os = "macos")))]
    let opener = "xdg-open";
    std::process::Command::new(opener)
        .arg(&dir)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// 치지직 페이지를 기본 브라우저로 연다 (채널 우클릭 → 채널 열기).
#[tauri::command]
async fn open_url(url: String) -> Result<(), String> {
    let parsed: Url = url.parse().map_err(|e: url::ParseError| e.to_string())?;
    if parsed.scheme() != "https" || parsed.host_str() != Some("chzzk.naver.com") {
        return Err(format!("허용되지 않은 주소: {url}"));
    }
    #[cfg(target_os = "windows")]
    let (opener, args): (&str, Vec<&str>) = ("cmd", vec!["/C", "start", ""]);
    #[cfg(target_os = "macos")]
    let (opener, args): (&str, Vec<&str>) = ("open", vec![]);
    #[cfg(all(unix, not(target_os = "macos")))]
    let (opener, args): (&str, Vec<&str>) = ("xdg-open", vec![]);
    std::process::Command::new(opener)
        .args(args)
        .arg(parsed.as_str())
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// 파일·폴더 이름으로 쓸 수 없는 문자를 걸러낸다.
fn sanitize_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .filter(|c| {
            !matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') && !c.is_control()
        })
        .collect();
    cleaned.trim().trim_matches('.').to_string()
}

/// 채팅 한 줄을 방송 회차별 로그 파일에 append한다.
/// 경로: <로그 폴더>/<채널명>/<파일명>
///
/// `header`를 주면 파일을 새로 만들 때에만 맨 앞에 한 번 써 넣는다
/// (방송 시작 시각·제목·카테고리, csv의 열 이름 등).
/// `line`이 비어 있으면 파일과 머리말만 만들어 둔다.
#[tauri::command]
async fn append_chat_log(
    app: AppHandle,
    channel: String,
    file_name: String,
    header: Option<String>,
    line: String,
    base_dir: Option<String>,
) -> Result<(), String> {
    use std::io::Write;

    let safe_channel = sanitize_name(&channel);
    if safe_channel.is_empty() {
        return Err("잘못된 채널명".into());
    }
    let safe_file = sanitize_name(&file_name);
    if safe_file.is_empty() || safe_file.contains("..") {
        return Err("잘못된 파일명".into());
    }

    let dir = resolve_log_base(&app, &base_dir)?.join(safe_channel);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let path = dir.join(safe_file);
    let is_new = !path.exists();
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| e.to_string())?;
    if is_new {
        if let Some(head) = header {
            if !head.is_empty() {
                writeln!(file, "{head}").map_err(|e| e.to_string())?;
            }
        }
    }
    if !line.is_empty() {
        writeln!(file, "{}", line.replace('\n', " ")).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 웹뷰에 남아 있는 네이버 로그인 세션을 정리한다.
/// (숨김 창으로 네이버 로그아웃 URL을 잠시 열었다가 닫는 방식)
#[tauri::command]
async fn naver_logout(app: AppHandle) -> Result<(), String> {
    const LOGOUT_WINDOW: &str = "naver-logout";
    if app.get_webview_window(LOGOUT_WINDOW).is_some() {
        return Ok(());
    }
    let url: Url =
        "https://nid.naver.com/nidlogin.logout?returl=https%3A%2F%2Fwww.naver.com"
            .parse()
            .unwrap();
    let w = WebviewWindowBuilder::new(&app, LOGOUT_WINDOW, WebviewUrl::External(url))
        .visible(false)
        .build()
        .map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(3)).await;
        let _ = w.close();
    });
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_sql::Builder::default().build())
        .plugin(tauri_plugin_websocket::init())
        .invoke_handler(tauri::generate_handler![
            naver_login,
            naver_logout,
            append_chat_log,
            chzzk_get,
            get_default_log_dir,
            open_log_dir,
            open_url,
            get_default_db_path,
            prepare_db_dir,
            open_dir
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
