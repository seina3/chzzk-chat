use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Url, WebviewUrl, WebviewWindowBuilder};

const USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const LOGIN_WINDOW: &str = "naver-login";
const LOGIN_URL: &str =
    "https://nid.naver.com/nidlogin.login?url=https%3A%2F%2Fchzzk.naver.com%2F";

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
    WebviewWindowBuilder::new(&app, LOGIN_WINDOW, WebviewUrl::External(url))
        .title("네이버 로그인")
        .inner_size(520.0, 720.0)
        .build()
        .map_err(|e| e.to_string())?;

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

/// 채팅 한 줄을 채널별/날짜별 txt 로그 파일에 append한다.
/// 경로: <로그 폴더>/<채널명>/<YYYY-MM-DD>.txt
#[tauri::command]
async fn append_chat_log(
    app: AppHandle,
    channel: String,
    date: String,
    line: String,
    base_dir: Option<String>,
) -> Result<(), String> {
    use std::io::Write;

    let safe_channel: String = channel
        .chars()
        .filter(|c| !matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') && !c.is_control())
        .collect();
    let safe_channel = safe_channel.trim().trim_matches('.').to_string();
    if safe_channel.is_empty() {
        return Err("잘못된 채널명".into());
    }
    if date.len() != 10 || !date.chars().all(|c| c.is_ascii_digit() || c == '-') {
        return Err("잘못된 날짜".into());
    }

    let dir = resolve_log_base(&app, &base_dir)?.join(safe_channel);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join(format!("{date}.txt")))
        .map_err(|e| e.to_string())?;
    writeln!(file, "{}", line.replace('\n', " ")).map_err(|e| e.to_string())?;
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
            open_log_dir
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
