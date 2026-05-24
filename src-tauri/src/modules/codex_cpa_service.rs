use crate::modules::{codex_account, logger};
use flate2::read::GzDecoder;
use serde::{Deserialize, Serialize};
use std::fs::{self, File};
use std::io::Write;
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tar::Archive;
use tauri::{AppHandle, Manager};

pub const CPA_SERVICE_PORT: u16 = 8317;
pub const CPA_SERVICE_API_KEY: &str = "your-api-key-1";
pub const CPA_SERVICE_BASE_URL: &str = "http://127.0.0.1:8317/v1";
pub const CPA_SERVICE_MANAGEMENT_PASSWORD: &str = "ab2026ab";

const CPA_BINARY_NAME: &str = "cli-proxy-api";
const CPA_RELEASE_API_URL: &str = "https://api.github.com/repos/router-for-me/CLIProxyAPI/releases/latest";
const CPA_SOURCE_URL: &str = "https://github.com/router-for-me/CLIProxyAPI";
const CPA_RELEASES_URL: &str = "https://github.com/router-for-me/CLIProxyAPI/releases";
const CPA_MANAGEMENT_PASSWORD_FILE: &str = "management_password.txt";

static CPA_PROCESS: OnceLock<Mutex<Option<Child>>> = OnceLock::new();

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexCpaRuntimeInfo {
    pub version: String,
    pub platform: String,
    pub path: String,
    pub package_name: Option<String>,
    pub imported_at: Option<String>,
    pub current: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexCpaUpdateInfo {
    pub source_url: String,
    pub releases_url: String,
    pub latest_version: Option<String>,
    pub current_version: Option<String>,
    pub update_available: bool,
    pub asset_name: Option<String>,
    pub download_url: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexCpaServiceState {
    pub running: bool,
    pub pid: Option<u32>,
    pub runtime_installed: bool,
    pub runtime_version: Option<String>,
    pub installed_runtimes: Vec<CodexCpaRuntimeInfo>,
    pub source_url: String,
    pub releases_url: String,
    pub port: u16,
    pub base_url: String,
    pub api_key: String,
    pub management_url: String,
    pub management_password: String,
    pub auth_dir: String,
    pub config_path: String,
    pub config_content: Option<String>,
    pub runtime_path: String,
}

#[cfg(not(all(target_os = "macos", target_arch = "aarch64")))]
fn ensure_supported_target() -> Result<(), String> {
    current_platform_key().map(|_| ())
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
fn ensure_supported_target() -> Result<(), String> {
    Ok(())
}

fn process_slot() -> &'static Mutex<Option<Child>> {
    CPA_PROCESS.get_or_init(|| Mutex::new(None))
}

fn cpa_root_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|path| path.join("cpa-service"))
        .map_err(|error| format!("获取应用数据目录失败: {}", error))
}

fn workspace_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(cpa_root_dir(app)?.join("workspace"))
}

fn runtimes_root_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(cpa_root_dir(app)?.join("runtime"))
}

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(workspace_dir(app)?.join("config.yaml"))
}

fn package_cache_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(cpa_root_dir(app)?.join("packages"))
}

fn management_password_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(workspace_dir(app)?.join(CPA_MANAGEMENT_PASSWORD_FILE))
}

fn read_management_password(app: &AppHandle) -> String {
    management_password_path(app)
        .ok()
        .and_then(|path| fs::read_to_string(path).ok())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| CPA_SERVICE_MANAGEMENT_PASSWORD.to_string())
}

fn write_management_password(app: &AppHandle, password: &str) -> Result<(), String> {
    let path = management_password_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("创建 CPA 工作目录失败: {}", error))?;
    }
    fs::write(path, password.trim())
        .map_err(|error| format!("保存 CPA 本机管理密钥失败: {}", error))
}

#[cfg(unix)]
fn ensure_executable(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    let mut permissions = fs::metadata(path)
        .map_err(|error| format!("读取 CPA 可执行文件权限失败: {}", error))?
        .permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(path, permissions)
        .map_err(|error| format!("设置 CPA 可执行权限失败: {}", error))
}

#[cfg(not(unix))]
fn ensure_executable(_path: &Path) -> Result<(), String> {
    Ok(())
}

fn split_version_parts(version: &str) -> Vec<u32> {
    version
        .trim_start_matches('v')
        .split('.')
        .map(|part| {
            part.chars()
                .take_while(|ch| ch.is_ascii_digit())
                .collect::<String>()
                .parse::<u32>()
                .unwrap_or(0)
        })
        .collect()
}

fn version_is_newer(left: &str, right: &str) -> bool {
    let mut left_parts = split_version_parts(left);
    let mut right_parts = split_version_parts(right);
    let max_len = left_parts.len().max(right_parts.len());
    left_parts.resize(max_len, 0);
    right_parts.resize(max_len, 0);
    left_parts > right_parts
}

fn normalize_version(value: &str) -> String {
    value.trim().trim_start_matches('v').to_string()
}

fn current_platform_key() -> Result<&'static str, String> {
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        Ok("darwin_aarch64")
    }
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    {
        Ok("darwin_amd64")
    }
    #[cfg(all(target_os = "linux", target_arch = "aarch64"))]
    {
        Ok("linux_aarch64")
    }
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    {
        Ok("linux_amd64")
    }
    #[cfg(all(target_os = "windows", target_arch = "aarch64"))]
    {
        Ok("windows_aarch64")
    }
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    {
        Ok("windows_amd64")
    }
    #[cfg(not(any(
        all(target_os = "macos", target_arch = "aarch64"),
        all(target_os = "macos", target_arch = "x86_64"),
        all(target_os = "linux", target_arch = "aarch64"),
        all(target_os = "linux", target_arch = "x86_64"),
        all(target_os = "windows", target_arch = "aarch64"),
        all(target_os = "windows", target_arch = "x86_64")
    )))]
    {
        Err("当前平台暂不支持自动匹配 CPA 运行时".to_string())
    }
}

fn parse_package_filename(path: &Path) -> Result<(String, String, String), String> {
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "CPA 安装包文件名无效".to_string())?
        .to_string();

    let without_ext = file_name
        .strip_suffix(".tar.gz")
        .ok_or_else(|| "CPA 安装包仅支持 .tar.gz 文件".to_string())?;
    let parts: Vec<&str> = without_ext.split('_').collect();
    if parts.len() < 3 || parts[0] != "CLIProxyAPI" {
        return Err("CPA 安装包文件名应类似 CLIProxyAPI_7.1.19_darwin_aarch64.tar.gz".to_string());
    }
    let version = normalize_version(parts[1]);
    let platform = parts[2..].join("_");
    Ok((version, platform, file_name))
}

fn normalize_platform_alias(value: &str) -> String {
    value.replace("arm64", "aarch64")
}

fn platform_matches_current(value: &str) -> bool {
    let Ok(current) = current_platform_key() else {
        return false;
    };
    normalize_platform_alias(value) == normalize_platform_alias(current)
}

fn runtime_dir_for_version(app: &AppHandle, version: &str) -> Result<PathBuf, String> {
    Ok(runtimes_root_dir(app)?.join(normalize_version(version)))
}

fn runtime_binary_path(runtime: &Path) -> PathBuf {
    runtime.join(CPA_BINARY_NAME)
}

fn read_runtime_sidecar(runtime: &Path, name: &str) -> Option<String> {
    fs::read_to_string(runtime.join(name))
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn find_runtime_binary(dir: &Path) -> Option<PathBuf> {
    let direct = runtime_binary_path(dir);
    if direct.exists() {
        return Some(direct);
    }
    let entries = fs::read_dir(dir).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if let Some(found) = find_runtime_binary(&path) {
                return Some(found);
            }
        } else if path
            .file_name()
            .and_then(|value| value.to_str())
            .map(|value| value == CPA_BINARY_NAME)
            .unwrap_or(false)
        {
            return Some(path);
        }
    }
    None
}

fn install_runtime_package(app: &AppHandle, package_path: &Path) -> Result<CodexCpaServiceState, String> {
    ensure_supported_target()?;
    let (version, platform, package_name) = parse_package_filename(package_path)?;
    if !platform_matches_current(&platform) {
        return Err(format!(
            "安装包平台 {} 与当前平台 {} 不匹配",
            platform,
            current_platform_key().unwrap_or("unknown")
        ));
    }

    let target_dir = runtime_dir_for_version(app, &version)?;
    if target_dir.exists() {
        fs::remove_dir_all(&target_dir)
            .map_err(|error| format!("清理旧 CPA 运行时失败: {}", error))?;
    }
    fs::create_dir_all(&target_dir)
        .map_err(|error| format!("创建 CPA 运行时目录失败: {}", error))?;

    let archive_file =
        File::open(package_path).map_err(|error| format!("打开 CPA 安装包失败: {}", error))?;
    let decoder = GzDecoder::new(archive_file);
    let mut archive = Archive::new(decoder);
    archive
        .unpack(&target_dir)
        .map_err(|error| format!("解压 CPA 安装包失败: {}", error))?;

    let binary_path = find_runtime_binary(&target_dir).ok_or_else(|| {
        format!(
            "CPA 安装包缺少可执行文件: {}",
            runtime_binary_path(&target_dir).display()
        )
    })?;
    if binary_path != runtime_binary_path(&target_dir) {
        fs::copy(&binary_path, runtime_binary_path(&target_dir))
            .map_err(|error| format!("整理 CPA 可执行文件失败: {}", error))?;
    }
    ensure_executable(&runtime_binary_path(&target_dir))?;
    write_runtime_sidecar(&target_dir, "platform.txt", &platform);
    write_runtime_sidecar(&target_dir, "package_name.txt", &package_name);
    write_runtime_sidecar(&target_dir, "imported_at.txt", &chrono::Utc::now().to_rfc3339());

    let config = config_path(app)?;
    if !config.exists() {
        let workspace = workspace_dir(app)?;
        fs::create_dir_all(&workspace)
            .map_err(|error| format!("创建 CPA 工作目录失败: {}", error))?;
        fs::write(&config, default_config_content(Some(&target_dir)))
            .map_err(|error| format!("写入 CPA 配置失败: {}", error))?;
    }
    Ok(build_state(app)?)
}

fn write_runtime_sidecar(runtime: &Path, name: &str, value: &str) {
    let _ = fs::write(runtime.join(name), value);
}

fn list_installed_runtimes(app: &AppHandle) -> Result<Vec<CodexCpaRuntimeInfo>, String> {
    let root = runtimes_root_dir(app)?;
    let mut items = Vec::new();
    if !root.exists() {
        return Ok(items);
    }

    for entry in fs::read_dir(&root).map_err(|error| format!("读取 CPA 运行时目录失败: {}", error))? {
        let entry = entry.map_err(|error| format!("读取 CPA 运行时条目失败: {}", error))?;
        let path = entry.path();
        if !path.is_dir() || !runtime_binary_path(&path).exists() {
            continue;
        }
        let version = entry
            .file_name()
            .to_string_lossy()
            .trim()
            .to_string();
        let platform = read_runtime_sidecar(&path, "platform.txt")
            .unwrap_or_else(|| current_platform_key().unwrap_or("unknown").to_string());
        let imported_at = read_runtime_sidecar(&path, "imported_at.txt");
        let package_name = read_runtime_sidecar(&path, "package_name.txt");
        items.push(CodexCpaRuntimeInfo {
            version,
            platform,
            path: path.to_string_lossy().to_string(),
            package_name,
            imported_at,
            current: false,
        });
    }

    items.sort_by(|left, right| {
        if version_is_newer(&left.version, &right.version) {
            std::cmp::Ordering::Less
        } else if version_is_newer(&right.version, &left.version) {
            std::cmp::Ordering::Greater
        } else {
            left.version.cmp(&right.version)
        }
    });
    if let Some(first) = items.first_mut() {
        first.current = true;
    }
    Ok(items)
}

fn current_runtime(app: &AppHandle) -> Result<Option<CodexCpaRuntimeInfo>, String> {
    Ok(list_installed_runtimes(app)?.into_iter().find(|item| item.current))
}

fn ensure_runtime(app: &AppHandle) -> Result<PathBuf, String> {
    ensure_supported_target()?;
    let runtime = current_runtime(app)?.ok_or_else(|| {
        format!(
            "未安装 CPA 运行时，请先下载或导入 {} 对应平台安装包。",
            current_platform_key().unwrap_or("当前平台")
        )
    })?;
    let binary_path = PathBuf::from(runtime.path).join(CPA_BINARY_NAME);

    if !binary_path.exists() {
        return Err(format!(
            "CPA 运行时缺少可执行文件: {}",
            binary_path.display()
        ));
    }
    ensure_executable(&binary_path)?;
    Ok(binary_path)
}

fn default_config_content(runtime_dir: Option<&Path>) -> String {
    let example_content = runtime_dir
        .map(|path| path.join("config.example.yaml"))
        .and_then(|path| fs::read_to_string(path).ok());
    let mut content = example_content.unwrap_or_else(|| {
        format!(
            r#"host: "127.0.0.1"
port: {CPA_SERVICE_PORT}
remote-management:
  allow-remote: false
  secret-key: ""
  disable-control-panel: false
  panel-github-repository: "https://github.com/router-for-me/Cli-Proxy-API-Management-Center"
auth-dir: "~/.cli-proxy-api"
api-keys:
  - "{CPA_SERVICE_API_KEY}"
debug: false
usage-statistics-enabled: false
"#
        )
    });

    content = content.replace("host: \"\"", "host: \"127.0.0.1\"");
    content = content.replace("port: 8317", &format!("port: {}", CPA_SERVICE_PORT));
    content = content.replace(
        "auth-dir: \"~/.cli-proxy-api\"",
        "auth-dir: \"~/.cli-proxy-api\"",
    );
    content = content.replace(
        "usage-statistics-enabled: false",
        "usage-statistics-enabled: false",
    );
    if !content.contains(CPA_SERVICE_API_KEY) {
        content.push_str(&format!("\napi-keys:\n  - \"{}\"\n", CPA_SERVICE_API_KEY));
    }
    content
}

fn ensure_config(app: &AppHandle, binary_path: &Path) -> Result<PathBuf, String> {
    let path = config_path(app)?;
    let workspace = workspace_dir(app)?;
    fs::create_dir_all(&workspace).map_err(|error| format!("创建 CPA 工作目录失败: {}", error))?;
    if !path.exists() {
        let runtime = binary_path
            .parent()
            .ok_or_else(|| "CPA 运行时路径无效".to_string())?;
        fs::write(&path, default_config_content(Some(runtime)))
            .map_err(|error| format!("写入 CPA 配置失败: {}", error))?;
    }
    Ok(path)
}

fn parse_config_port(content: &str) -> u16 {
    content
        .lines()
        .find_map(|line| {
            let trimmed = line.trim();
            let value = trimmed.strip_prefix("port:")?.trim().trim_matches('"');
            value.parse::<u16>().ok()
        })
        .unwrap_or(CPA_SERVICE_PORT)
}

fn read_config_port(app: &AppHandle) -> u16 {
    config_path(app)
        .ok()
        .and_then(|path| fs::read_to_string(path).ok())
        .map(|content| parse_config_port(&content))
        .unwrap_or(CPA_SERVICE_PORT)
}

fn is_port_open(port: u16) -> bool {
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    TcpStream::connect_timeout(&address, Duration::from_millis(250)).is_ok()
}

fn wait_until_port_closed(port: u16, timeout: Duration) -> bool {
    let started_at = Instant::now();
    while started_at.elapsed() < timeout {
        if !is_port_open(port) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(150));
    }
    !is_port_open(port)
}

fn current_managed_pid() -> Result<Option<u32>, String> {
    let mut guard = process_slot()
        .lock()
        .map_err(|_| "CPA 服务状态锁已损坏".to_string())?;
    if let Some(child) = guard.as_mut() {
        match child.try_wait() {
            Ok(Some(_)) => {
                *guard = None;
                Ok(None)
            }
            Ok(None) => Ok(Some(child.id())),
            Err(error) => Err(format!("检查 CPA 服务进程失败: {}", error)),
        }
    } else {
        Ok(None)
    }
}

#[cfg(unix)]
fn command_output_text(command: &mut Command) -> Option<String> {
    let output = command.output().ok()?;
    if !output.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

#[cfg(unix)]
fn listening_pids_for_port(port: u16) -> Vec<u32> {
    let mut command = Command::new("lsof");
    command
        .arg("-nP")
        .arg(format!("-iTCP:{}", port))
        .arg("-sTCP:LISTEN")
        .arg("-t");
    let Some(output) = command_output_text(&mut command) else {
        return Vec::new();
    };

    output
        .lines()
        .filter_map(|line| line.trim().parse::<u32>().ok())
        .collect()
}

#[cfg(unix)]
fn process_command_text(pid: u32) -> String {
    let mut command = Command::new("ps");
    command.arg("-p").arg(pid.to_string()).arg("-o").arg("command=");
    command_output_text(&mut command).unwrap_or_default()
}

#[cfg(unix)]
fn process_looks_like_cpa(app: &AppHandle, pid: u32) -> bool {
    let command_text = process_command_text(pid);
    if command_text.contains(CPA_BINARY_NAME) {
        return true;
    }

    if let Ok(root) = runtimes_root_dir(app) {
        if command_text.contains(&root.to_string_lossy().to_string()) {
            return true;
        }
    }

    if let Ok(config) = config_path(app) {
        if command_text.contains(&config.to_string_lossy().to_string()) {
            return true;
        }
    }

    false
}

#[cfg(unix)]
fn external_cpa_pids(app: &AppHandle, port: u16) -> Vec<u32> {
    listening_pids_for_port(port)
        .into_iter()
        .filter(|pid| process_looks_like_cpa(app, *pid))
        .collect()
}

#[cfg(not(unix))]
fn external_cpa_pids(_app: &AppHandle, _port: u16) -> Vec<u32> {
    Vec::new()
}

fn current_cpa_pid(app: &AppHandle) -> Result<Option<u32>, String> {
    if let Some(pid) = current_managed_pid()? {
        return Ok(Some(pid));
    }
    let port = read_config_port(app);
    Ok(external_cpa_pids(app, port).into_iter().next())
}

fn build_state(app: &AppHandle) -> Result<CodexCpaServiceState, String> {
    let pid = current_cpa_pid(app)?;
    let port = read_config_port(app);
    let installed_runtimes = list_installed_runtimes(app)?;
    let runtime = installed_runtimes.iter().find(|item| item.current);
    let running = pid.is_some() || is_port_open(port);
    let auth_dir = codex_account::get_cpa_dir()?;
    let config_path = config_path(app)?;
    let config_content = fs::read_to_string(&config_path).ok();
    let runtime_path = runtime
        .map(|item| item.path.clone())
        .unwrap_or_else(|| {
            runtimes_root_dir(app)
                .map(|path| path.to_string_lossy().to_string())
                .unwrap_or_default()
        });
    Ok(CodexCpaServiceState {
        running,
        pid,
        runtime_installed: runtime.is_some(),
        runtime_version: runtime.map(|item| item.version.clone()),
        installed_runtimes,
        source_url: CPA_SOURCE_URL.to_string(),
        releases_url: CPA_RELEASES_URL.to_string(),
        port,
        base_url: format!("http://127.0.0.1:{}/v1", port),
        api_key: CPA_SERVICE_API_KEY.to_string(),
        management_url: format!("http://127.0.0.1:{}/management.html", port),
        management_password: read_management_password(app),
        auth_dir: auth_dir.to_string_lossy().to_string(),
        config_path: config_path.to_string_lossy().to_string(),
        config_content,
        runtime_path,
    })
}

pub fn get_state(app: &AppHandle) -> Result<CodexCpaServiceState, String> {
    build_state(app)
}

pub fn ensure_running(app: &AppHandle) -> Result<CodexCpaServiceState, String> {
    ensure_supported_target()?;
    codex_account::get_cpa_dir_path()?;

    let port = read_config_port(app);
    if current_managed_pid()?.is_some() || is_port_open(port) {
        return build_state(app);
    }

    let binary_path = ensure_runtime(app)?;
    let path = ensure_config(app, &binary_path)?;
    let workspace = workspace_dir(app)?;

    let mut command = Command::new(&binary_path);
    command
        .arg("--config")
        .arg(&path)
        .current_dir(&workspace)
        .env("MANAGEMENT_PASSWORD", read_management_password(app))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    let child = command
        .spawn()
        .map_err(|error| format!("启动 CPA 服务失败: {}", error))?;
    let pid = child.id();
    {
        let mut guard = process_slot()
            .lock()
            .map_err(|_| "CPA 服务状态锁已损坏".to_string())?;
        *guard = Some(child);
    }

    let started_at = Instant::now();
    while started_at.elapsed() < Duration::from_secs(8) {
        if is_port_open(port) {
            logger::log_info(&format!(
                "[CodexCPA] CPA 服务已启动: pid={}, base={}",
                pid,
                format!("http://127.0.0.1:{}/v1", port)
            ));
            return build_state(app);
        }
        std::thread::sleep(Duration::from_millis(150));
    }

    Err(format!(
        "CPA 服务已拉起但端口 {} 暂未监听，请稍后重试",
        port
    ))
}

pub fn stop_managed_process() -> bool {
    let Ok(mut guard) = process_slot().lock() else {
        return false;
    };
    let mut stopped = false;
    if let Some(child) = guard.as_mut() {
        let _ = child.kill();
        let _ = child.wait();
        stopped = true;
    }
    *guard = None;
    stopped
}

#[cfg(unix)]
fn is_pid_alive(pid: u32) -> bool {
    Command::new("kill")
        .arg("-0")
        .arg(pid.to_string())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

#[cfg(unix)]
fn signal_pid(pid: u32, signal: &str) -> bool {
    Command::new("kill")
        .arg(signal)
        .arg(pid.to_string())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

#[cfg(unix)]
fn stop_external_cpa_processes(app: &AppHandle, port: u16) -> bool {
    let pids = external_cpa_pids(app, port);
    if pids.is_empty() {
        return false;
    }

    for pid in &pids {
        let _ = signal_pid(*pid, "-TERM");
    }

    let started_at = Instant::now();
    while started_at.elapsed() < Duration::from_secs(3) {
        if pids.iter().all(|pid| !is_pid_alive(*pid)) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(120));
    }

    for pid in &pids {
        if is_pid_alive(*pid) {
            let _ = signal_pid(*pid, "-KILL");
        }
    }
    true
}

#[cfg(not(unix))]
fn stop_external_cpa_processes(_app: &AppHandle, _port: u16) -> bool {
    false
}

fn request_stop_for_port(app: &AppHandle, port: u16) -> (bool, bool) {
    let stopped_managed = stop_managed_process();
    let stopped_external = stop_external_cpa_processes(app, port);
    (stopped_managed, stopped_external)
}

pub fn stop(app: &AppHandle) -> Result<CodexCpaServiceState, String> {
    let port = read_config_port(app);
    let (stopped_managed, stopped_external) = request_stop_for_port(app, port);

    if wait_until_port_closed(port, Duration::from_secs(4)) {
        return build_state(app);
    }

    let state = build_state(app)?;
    if state.running {
        if stopped_managed || stopped_external {
            return Err(format!(
                "已向 CPA 服务发送停止信号，但端口 {} 仍在监听，请稍后刷新状态。",
                port
            ));
        }
        return Err(format!(
            "未找到可停止的 CPA 服务进程，端口 {} 仍在监听。请确认是否由外部程序启动。",
            port
        ));
    }
    Ok(state)
}

pub fn list_runtimes(app: &AppHandle) -> Result<Vec<CodexCpaRuntimeInfo>, String> {
    list_installed_runtimes(app)
}

pub fn import_runtime_package(
    app: &AppHandle,
    package_path: String,
) -> Result<CodexCpaServiceState, String> {
    install_runtime_package(app, Path::new(&package_path))
}

pub fn save_config(
    app: &AppHandle,
    config_content: String,
    management_password: String,
) -> Result<CodexCpaServiceState, String> {
    let previous_port = read_config_port(app);
    let previous_managed_running = current_managed_pid()?.is_some();
    let previous_port_open = is_port_open(previous_port);
    let next_port = parse_config_port(&config_content);
    let path = config_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("创建 CPA 工作目录失败: {}", error))?;
    }
    fs::write(&path, config_content).map_err(|error| format!("保存 CPA 配置失败: {}", error))?;
    write_management_password(app, &management_password)?;
    if previous_managed_running {
        let _ = request_stop_for_port(app, previous_port);
        if !wait_until_port_closed(previous_port, Duration::from_secs(4)) {
            logger::log_warn(&format!(
                "[CodexCPA] 保存 CPA 配置后停止旧服务，旧端口 {} 仍在监听",
                previous_port
            ));
        }
        return build_state(app);
    }
    if previous_port_open && previous_port != next_port {
        logger::log_warn(&format!(
            "[CodexCPA] CPA 配置端口从 {} 改为 {}，旧端口仍由外部进程监听",
            previous_port, next_port
        ));
    }
    build_state(app)
}

pub fn restore_default_config(app: &AppHandle) -> Result<CodexCpaServiceState, String> {
    let previous_port = read_config_port(app);
    let previous_managed_running = current_managed_pid()?.is_some();
    let runtime_path = current_runtime(app)?.map(|item| PathBuf::from(item.path));
    let content = default_config_content(runtime_path.as_deref());
    let path = config_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("创建 CPA 工作目录失败: {}", error))?;
    }
    fs::write(&path, content).map_err(|error| format!("恢复 CPA 默认配置失败: {}", error))?;
    write_management_password(app, CPA_SERVICE_MANAGEMENT_PASSWORD)?;
    if previous_managed_running {
        let _ = request_stop_for_port(app, previous_port);
        if !wait_until_port_closed(previous_port, Duration::from_secs(4)) {
            logger::log_warn(&format!(
                "[CodexCPA] 恢复 CPA 默认配置后停止旧服务，旧端口 {} 仍在监听",
                previous_port
            ));
        }
        return build_state(app);
    }
    build_state(app)
}

#[derive(Debug, Deserialize)]
struct GithubReleaseAsset {
    name: String,
    browser_download_url: String,
}

#[derive(Debug, Deserialize)]
struct GithubRelease {
    tag_name: String,
    html_url: Option<String>,
    assets: Vec<GithubReleaseAsset>,
}

fn target_asset_name(version: &str) -> Result<String, String> {
    let platform = current_platform_key()?;
    Ok(format!(
        "CLIProxyAPI_{}_{}.tar.gz",
        normalize_version(version),
        platform
    ))
}

fn build_update_info(
    release: GithubRelease,
    current_version: Option<String>,
) -> Result<CodexCpaUpdateInfo, String> {
    let latest_version = normalize_version(&release.tag_name);
    let target_asset = target_asset_name(&latest_version)?;
    let asset = release
        .assets
        .into_iter()
        .find(|item| item.name == target_asset)
        .ok_or_else(|| format!("最新版本缺少当前平台安装包: {}", target_asset))?;
    let update_available = current_version
        .as_deref()
        .map(|current| version_is_newer(&latest_version, current))
        .unwrap_or(true);
    Ok(CodexCpaUpdateInfo {
        source_url: CPA_SOURCE_URL.to_string(),
        releases_url: release.html_url.unwrap_or_else(|| CPA_RELEASES_URL.to_string()),
        latest_version: Some(latest_version),
        current_version,
        update_available,
        asset_name: Some(asset.name),
        download_url: Some(asset.browser_download_url),
    })
}

async fn fetch_latest_release() -> Result<GithubRelease, String> {
    let client = reqwest::Client::builder()
        .user_agent("Cockpit-Tools")
        .build()
        .map_err(|error| format!("创建 CPA 更新检查客户端失败: {}", error))?;
    let response = client
        .get(CPA_RELEASE_API_URL)
        .send()
        .await
        .map_err(|error| format!("检测 CPA 更新失败: {}", error))?;
    if !response.status().is_success() {
        return Err(format!("检测 CPA 更新失败: HTTP {}", response.status()));
    }
    response
        .json::<GithubRelease>()
        .await
        .map_err(|error| format!("解析 CPA 更新信息失败: {}", error))
}

pub async fn check_update(app: &AppHandle) -> Result<CodexCpaUpdateInfo, String> {
    ensure_supported_target()?;
    let current_version = current_runtime(app)?.map(|item| item.version);
    let release = fetch_latest_release().await?;
    build_update_info(release, current_version)
}

pub async fn download_latest(app: &AppHandle) -> Result<CodexCpaServiceState, String> {
    ensure_supported_target()?;
    let update = check_update(app).await?;
    let download_url = update
        .download_url
        .clone()
        .ok_or_else(|| "最新 CPA 版本没有可下载文件".to_string())?;
    let asset_name = update
        .asset_name
        .clone()
        .ok_or_else(|| "最新 CPA 版本缺少安装包名称".to_string())?;
    let cache_dir = package_cache_dir(app)?;
    fs::create_dir_all(&cache_dir).map_err(|error| format!("创建 CPA 下载目录失败: {}", error))?;
    let target_path = cache_dir.join(&asset_name);

    let client = reqwest::Client::builder()
        .user_agent("Cockpit-Tools")
        .build()
        .map_err(|error| format!("创建 CPA 下载客户端失败: {}", error))?;
    let response = client
        .get(&download_url)
        .send()
        .await
        .map_err(|error| format!("下载 CPA 安装包失败: {}", error))?;
    if !response.status().is_success() {
        return Err(format!("下载 CPA 安装包失败: HTTP {}", response.status()));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("读取 CPA 安装包失败: {}", error))?;
    let mut file = File::create(&target_path)
        .map_err(|error| format!("创建 CPA 安装包缓存失败: {}", error))?;
    file.write_all(&bytes)
        .map_err(|error| format!("写入 CPA 安装包缓存失败: {}", error))?;

    install_runtime_package(app, &target_path)
}
