use std::io::{self, Read};
use std::process::{Command, ExitCode, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

// ── Configuração visual da janela toast ───────────────────────────────────────

const TOAST_WIDTH: i32 = 352;
const TOAST_HEIGHT: i32 = 116;
const MARGIN_RIGHT: i32 = 16;
const MARGIN_BOTTOM: i32 = 48;

const DEFAULT_DURATION_MS: u64 = 5000;
const MIN_DURATION_MS: u64 = 1000;
const MAX_DURATION_MS: u64 = 60000;

// Usado quando o xrandr não responde (ex.: sessão sem X11).
const FALLBACK_SCREEN_WIDTH: i32 = 1920;
const FALLBACK_SCREEN_HEIGHT: i32 = 1080;

// ── Estrutura de dados da notificação ─────────────────────────────────────────

fn default_title() -> String {
    "Steam".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToastParams {
    #[serde(default, rename = "type")]
    pub kind: Option<String>,

    #[serde(default = "default_title")]
    pub title: String,

    #[serde(default)]
    pub message: Option<String>,

    #[serde(default)]
    pub game: Option<String>,

    #[serde(default)]
    pub icon: Option<String>,

    #[serde(default)]
    pub sound: Option<String>,

    #[serde(default)]
    pub duration: Option<u64>,
}

// ── Estado da aplicação ───────────────────────────────────────────────────────

pub struct AppState {
    pub params: ToastParams,
}

// ── Help CLI ──────────────────────────────────────────────────────────────────

fn print_help() {
    println!(
        r#"void-toast

Uso:
  void-toast --title="Título" --message="Mensagem" --game="VoidLauncher" --icon="🏆" --sound="/caminho/som.wav" --duration=5000

Também aceita JSON:
  void-toast --json '{{"title":"Download concluído","message":"Jogo pronto","game":"VoidLauncher","icon":"🏆","sound":"/caminho/som.wav","duration":5000}}'

Também aceita JSON via stdin:
  echo '{{"title":"Download concluído","message":"Jogo pronto"}}' | void-toast --stdin

Argumentos:
  --title        Título principal da notificação
  --message      Mensagem opcional
  --game         Fonte/app/jogo exibido no topo
  --icon         Emoji, URL ou caminho de imagem
  --sound        URL ou caminho do áudio a tocar
  --duration     Duração em ms. Mínimo: 1000. Máximo: 60000
  --json         Recebe todos os dados como JSON
  --stdin        Lê JSON do stdin
  --help         Mostra esta ajuda

Variáveis de ambiente:
  VOID_TOAST_X        Força posição X da janela
  VOID_TOAST_Y        Força posição Y da janela

Linux/XWayland:
  Para maior compatibilidade com always-on-top:
  WAYLAND_DISPLAY="" GDK_BACKEND=x11 void-toast --title="Teste"
"#
    );
}

// ── Utilitários CLI ───────────────────────────────────────────────────────────

fn normalize_params(mut params: ToastParams) -> ToastParams {
    params.title = params.title.trim().to_string();

    if params.title.is_empty() {
        params.title = default_title();
    }

    params.message = params
        .message
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty());

    params.game = params
        .game
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty());

    params.icon = params
        .icon
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty());

    params.sound = params
        .sound
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty());

    let duration = params.duration.unwrap_or(DEFAULT_DURATION_MS);
    params.duration = Some(duration.clamp(MIN_DURATION_MS, MAX_DURATION_MS));

    params
}

fn parse_json_params(json: &str) -> Result<ToastParams, String> {
    let params: ToastParams =
        serde_json::from_str(json).map_err(|err| format!("JSON inválido para toast: {}", err))?;

    Ok(normalize_params(params))
}

fn read_stdin_to_string() -> Result<String, String> {
    let mut input = String::new();

    io::stdin()
        .read_to_string(&mut input)
        .map_err(|err| format!("erro ao ler stdin: {}", err))?;

    if input.trim().is_empty() {
        return Err("stdin vazio; esperado JSON de notificação".to_string());
    }

    Ok(input)
}

fn parse_cli_params(args: &[String]) -> Result<ToastParams, String> {
    let mut params = ToastParams {
        kind: Some("info".to_string()),
        title: default_title(),
        message: None,
        game: None,
        icon: None,
        sound: None,
        duration: Some(DEFAULT_DURATION_MS),
    };

    let mut i = 1;

    while i < args.len() {
        let arg = &args[i];

        if arg == "--standalone" {
            // Mantido por compatibilidade com o protótipo antigo.
            i += 1;
            continue;
        }

        if arg == "--help" || arg == "-h" {
            print_help();
            std::process::exit(0);
        }

        if arg == "--stdin" {
            let input = read_stdin_to_string()?;
            return parse_json_params(&input);
        }

        if arg == "--json" {
            let json = args
                .get(i + 1)
                .ok_or_else(|| "--json precisa receber uma string JSON".to_string())?;

            return parse_json_params(json);
        }

        if let Some(json) = arg.strip_prefix("--json=") {
            return parse_json_params(json);
        }

        if let Some(rest) = arg.strip_prefix("--") {
            if let Some(eq) = rest.find('=') {
                let key = &rest[..eq];
                let val = rest[eq + 1..].to_string();

                match key {
                    "title" => params.title = val,
                    "message" => params.message = Some(val),
                    "game" => params.game = Some(val),
                    "icon" => params.icon = Some(val),
                    "sound" => params.sound = Some(val),
                    "duration" => {
                        params.duration = Some(
                            val.parse::<u64>()
                                .map_err(|_| format!("duration inválido: {}", val))?,
                        );
                    }
                    _ => {
                        eprintln!("[void-toast] argumento ignorado: --{}", key);
                    }
                }

                i += 1;
                continue;
            }

            let key = rest;

            match key {
                "title" | "message" | "game" | "icon" | "sound" | "duration" => {
                    let val = args
                        .get(i + 1)
                        .ok_or_else(|| format!("--{} precisa receber um valor", key))?
                        .to_string();

                    match key {
                        "title" => params.title = val,
                        "message" => params.message = Some(val),
                        "game" => params.game = Some(val),
                        "icon" => params.icon = Some(val),
                        "sound" => params.sound = Some(val),
                        "duration" => {
                            params.duration = Some(
                                val.parse::<u64>()
                                    .map_err(|_| format!("duration inválido: {}", val))?,
                            );
                        }
                        _ => {}
                    }

                    i += 2;
                    continue;
                }
                _ => {
                    eprintln!("[void-toast] argumento ignorado: --{}", key);
                    i += 1;
                    continue;
                }
            }
        }

        eprintln!("[void-toast] argumento ignorado: {}", arg);
        i += 1;
    }

    Ok(normalize_params(params))
}

fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;

    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(hex) = std::str::from_utf8(&bytes[i + 1..i + 3]) {
                if let Ok(decoded) = u8::from_str_radix(hex, 16) {
                    out.push(decoded);
                    i += 3;
                    continue;
                }
            }
        }

        out.push(bytes[i]);
        i += 1;
    }

    String::from_utf8_lossy(&out).into_owned()
}

fn sound_source_to_path(sound: &str) -> Option<String> {
    let value = sound.trim();
    if value.is_empty()
        || value.starts_with("http://")
        || value.starts_with("https://")
        || value.starts_with("data:")
    {
        return None;
    }

    if let Some(rest) = value.strip_prefix("file://") {
        let without_host = rest
            .strip_prefix("localhost/")
            .map(|v| format!("/{}", v))
            .unwrap_or_else(|| rest.to_string());

        #[cfg(target_os = "windows")]
        {
            let path = without_host.trim_start_matches('/');
            return Some(percent_decode(path));
        }

        #[cfg(not(target_os = "windows"))]
        {
            return Some(percent_decode(&without_host));
        }
    }

    Some(value.to_string())
}

fn spawn_sound_command(command: &str, args: &[&str]) -> bool {
    Command::new(command)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .is_ok()
}

#[cfg(target_os = "linux")]
fn play_sound_path(path: &str) -> bool {
    spawn_sound_command("pw-play", &[path])
        || spawn_sound_command("paplay", &[path])
        || spawn_sound_command("aplay", &["-q", path])
        || spawn_sound_command("gst-play-1.0", &["--no-interactive", path])
}

#[cfg(target_os = "windows")]
fn play_sound_path(path: &str) -> bool {
    use std::os::windows::process::CommandExt;

    Command::new("powershell")
        // WindowStyle alone still allows a console to flash and activate.
        .creation_flags(0x08000000) // CREATE_NO_WINDOW
        .args([
            "-NoProfile",
            "-WindowStyle",
            "Hidden",
            "-Command",
            "Add-Type -AssemblyName System.Windows.Forms; $p = $env:VOID_TOAST_SOUND; $player = New-Object System.Media.SoundPlayer $p; $player.PlaySync()",
        ])
        .env("VOID_TOAST_SOUND", path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .is_ok()
}

#[cfg(target_os = "macos")]
fn play_sound_path(path: &str) -> bool {
    spawn_sound_command("afplay", &[path])
}

#[cfg(not(any(target_os = "linux", target_os = "windows", target_os = "macos")))]
fn play_sound_path(_path: &str) -> bool {
    false
}

fn play_sound_async(sound: Option<String>) {
    let Some(sound) = sound else { return };
    let Some(path) = sound_source_to_path(&sound) else {
        return;
    };

    thread::spawn(move || {
        if !play_sound_path(&path) {
            eprintln!(
                "[void-toast] nenhum player de áudio disponível para: {}",
                path
            );
        }
    });
}

// ── Parse simples de geometria do xrandr ──────────────────────────────────────
//
// Exemplos esperados:
// 1920x1080+0+0
// 2560x1440+1920+0

fn parse_xrandr_geometry(token: &str) -> Option<(i32, i32, i32, i32)> {
    let mut parts = token.split(['x', '+']);

    let width = parts.next()?.parse::<i32>().ok()?;
    let height = parts.next()?.parse::<i32>().ok()?;
    let x = parts.next()?.parse::<i32>().ok()?;
    let y = parts.next()?.parse::<i32>().ok()?;

    if width <= 0 || height <= 0 {
        return None;
    }

    Some((width, height, x, y))
}

// ── Obtém a geometria (largura, altura, x, y) do monitor via xrandr ───────────
//
// Evita usar primary_monitor/current_monitor do Tauri/Tao no Linux,
// porque essa área foi justamente onde o protótipo estava quebrando.

fn monitor_geometry_from_xrandr() -> Option<(i32, i32, i32, i32)> {
    let output = Command::new("xrandr").arg("--current").output().ok()?;

    if !output.status.success() {
        return None;
    }

    let stdout = String::from_utf8_lossy(&output.stdout);

    let mut first_connected: Option<(i32, i32, i32, i32)> = None;
    let mut primary_connected: Option<(i32, i32, i32, i32)> = None;

    for line in stdout.lines() {
        if !line.contains(" connected") {
            continue;
        }

        for token in line.split_whitespace() {
            if let Some(geometry) = parse_xrandr_geometry(token) {
                if first_connected.is_none() {
                    first_connected = Some(geometry);
                }

                if line.contains(" primary ") {
                    primary_connected = Some(geometry);
                }

                break;
            }
        }
    }

    primary_connected.or(first_connected)
}

// Canto inferior direito, usando o tamanho real da janela (em pixels físicos).
// Usar as constantes aqui erra a conta sempre que a janela não sai exatamente do
// tamanho pedido — HiDPI, altura mínima do webview — e o toast vaza pra fora da
// tela, já que uma janela de notificação não é reencaixada pelo WM.
fn calculate_toast_position(toast_width: i32, toast_height: i32) -> (i32, i32) {
    let env_x = std::env::var("VOID_TOAST_X")
        .ok()
        .and_then(|v| v.parse::<i32>().ok());

    let env_y = std::env::var("VOID_TOAST_Y")
        .ok()
        .and_then(|v| v.parse::<i32>().ok());

    if let (Some(x), Some(y)) = (env_x, env_y) {
        return (x, y);
    }

    let Some((screen_width, screen_height, screen_x, screen_y)) = monitor_geometry_from_xrandr()
    else {
        return (
            FALLBACK_SCREEN_WIDTH - toast_width - MARGIN_RIGHT,
            FALLBACK_SCREEN_HEIGHT - toast_height - MARGIN_BOTTOM,
        );
    };

    let x = screen_x + screen_width - toast_width - MARGIN_RIGHT;
    let y = screen_y + screen_height - toast_height - MARGIN_BOTTOM;

    // Nunca deixa a janela sair do monitor, mesmo que ela seja maior do que o esperado.
    (
        x.clamp(
            screen_x,
            (screen_x + screen_width - toast_width).max(screen_x),
        ),
        y.clamp(
            screen_y,
            (screen_y + screen_height - toast_height).max(screen_y),
        ),
    )
}

// ── Posiciona janela toast no canto inferior direito e força always-on-top ─────

fn toast_physical_size(win: &WebviewWindow) -> (i32, i32) {
    let scale = win.scale_factor().unwrap_or(1.0);
    let fallback = (
        (TOAST_WIDTH as f64 * scale).round() as i32,
        (TOAST_HEIGHT as f64 * scale).round() as i32,
    );

    // Nada de `outer_size()` aqui: no backend GTK do tao ele é inicializado com a
    // *posição* da janela (root_origin), então devolve lixo até a primeira
    // configure. A janela não tem decoração, logo inner == outer.
    match win.inner_size() {
        Ok(size) => {
            let (w, h) = (size.width as i32, size.height as i32);
            let plausible = w > 0 && h > 0 && w <= fallback.0 * 4 && h <= fallback.1 * 4;
            if plausible {
                (w, h)
            } else {
                fallback
            }
        }
        Err(_) => fallback,
    }
}

fn position_toast_window(win: &WebviewWindow) {
    let (width, height) = toast_physical_size(win);
    let (x, y) = calculate_toast_position(width, height);

    match win.set_position(tauri::Position::Physical(tauri::PhysicalPosition::new(
        x, y,
    ))) {
        Ok(_) => eprintln!(
            "[void-toast] toast {}x{} posicionado em ({}, {})",
            width, height, x, y
        ),
        Err(err) => eprintln!("[void-toast] erro ao posicionar toast: {:?}", err),
    }

    if let Err(err) = win.set_always_on_top(true) {
        eprintln!("[void-toast] erro em set_always_on_top: {:?}", err);
    }

    if let Err(err) = win.set_visible_on_all_workspaces(true) {
        eprintln!(
            "[void-toast] erro em set_visible_on_all_workspaces: {:?}",
            err
        );
    }
}

// ── Impede que o toast roube o foco do jogo ───────────────────────────────────
//
// Comportamento esperado (igual ao overlay da Steam): a notificação aparece por
// cima do jogo — inclusive em tela cheia / janela sem borda — sem nunca ativar a
// própria janela. No X11/XWayland isso depende de três coisas:
//
//   WM_HINTS.input = False              -> o WM não entrega foco pra janela
//   _NET_WM_USER_TIME = 0               -> mapear a janela não a ativa
//   _NET_WM_WINDOW_TYPE_NOTIFICATION    -> fica acima de fullscreen sem ativar

#[cfg(target_os = "linux")]
fn apply_no_focus_hints(win: &WebviewWindow) {
    use gtk::gdk::WindowTypeHint;
    use gtk::prelude::{GtkWindowExt, WidgetExt};

    let gtk_win = match win.gtk_window() {
        Ok(gtk_win) => gtk_win,
        Err(err) => {
            eprintln!("[void-toast] erro ao obter gtk_window: {:?}", err);
            return;
        }
    };

    gtk_win.set_accept_focus(false);
    gtk_win.set_focus_on_map(false);
    gtk_win.set_type_hint(WindowTypeHint::Notification);
    gtk_win.set_skip_taskbar_hint(true);
    gtk_win.set_skip_pager_hint(true);
    gtk_win.set_keep_above(true);

    // Store the empty input region on the GTK widget, not just its GDK window:
    // GTK reapplies the widget's region when mapping/resizing. This also avoids
    // Tao's cursor-ignore implementation, which unwraps an unrealized window
    // and leaves a 1x1 input region that can still intercept the game mouse.
    gtk_win.input_shape_combine_region(Some(&gtk::cairo::Region::create()));

    // Precisa da janela X criada (sem mapear) pra poder escrever a propriedade.
    gtk_win.realize();
    set_critical_notification_type(&gtk_win);
}

// ── Camada acima de janelas em tela cheia ─────────────────────────────────────
//
// `_NET_WM_WINDOW_TYPE_NOTIFICATION` sozinho não basta: no KWin a camada de
// notificações fica ABAIXO da ActiveLayer, que é onde vive a janela fullscreen
// focada — ou seja, o toast some atrás do jogo. Antes ele aparecia só porque
// roubava o foco e tirava o jogo dessa camada.
//
// A propriedade `_NET_WM_WINDOW_TYPE` é uma lista ordenada e o WM usa o primeiro
// tipo que reconhece (EWMH), então pedimos a camada de notificação crítica do
// KDE — feita exatamente para avisos que precisam aparecer sobre fullscreen — e
// deixamos o tipo padrão logo atrás, para os WMs que não conhecem o átomo do KDE.

#[cfg(target_os = "linux")]
fn set_critical_notification_type(gtk_win: &gtk::ApplicationWindow) {
    use gtk::glib::translate::ToGlibPtr;
    use gtk::prelude::{Cast, WidgetExt};
    use x11::xlib;

    let Some(gdk_win) = gtk_win.window() else {
        eprintln!("[void-toast] janela GDK indisponível; mantendo tipo notification");
        return;
    };

    let Ok(x11_win) = gdk_win.downcast::<gdkx11::X11Window>() else {
        // Backend Wayland nativo: nada a fazer aqui.
        return;
    };

    let xid = x11_win.xid();
    // EWMH explicitly reserves zero for windows that must not activate on map.
    x11_win.set_user_time(0);

    let Ok(x11_display) = gtk_win.display().downcast::<gdkx11::X11Display>() else {
        return;
    };

    unsafe {
        // Use GDK's connection so creation, hints and mapping are ordered on
        // the same X server. A second connection can race the initial realize.
        let display = gdkx11::ffi::gdk_x11_display_get_xdisplay(x11_display.to_glib_none().0);
        if display.is_null() {
            eprintln!("[void-toast] display X11 indisponível");
            return;
        }

        let intern = |name: &[u8]| xlib::XInternAtom(display, name.as_ptr() as *const _, 0);

        let property = intern(b"_NET_WM_WINDOW_TYPE\0");
        let atoms: [xlib::Atom; 2] = [
            intern(b"_KDE_NET_WM_WINDOW_TYPE_CRITICAL_NOTIFICATION\0"),
            intern(b"_NET_WM_WINDOW_TYPE_NOTIFICATION\0"),
        ];

        xlib::XChangeProperty(
            display,
            xid,
            property,
            xlib::XA_ATOM,
            32,
            xlib::PropModeReplace,
            atoms.as_ptr() as *const u8,
            atoms.len() as i32,
        );

        xlib::XFlush(display);
    }
}

#[cfg(not(target_os = "linux"))]
fn apply_no_focus_hints(win: &WebviewWindow) {
    if let Err(err) = win.set_ignore_cursor_events(true) {
        eprintln!(
            "[void-toast] erro ao desabilitar entrada do mouse: {:?}",
            err
        );
    }
}

// ── Cria janela toast ─────────────────────────────────────────────────────────

fn create_toast_window(app: &tauri::App) -> tauri::Result<WebviewWindow> {
    let (x, y) = calculate_toast_position(TOAST_WIDTH, TOAST_HEIGHT);

    eprintln!("[void-toast] criando janela toast em ({}, {})", x, y);

    let win = WebviewWindowBuilder::new(
        app,
        "toast",
        WebviewUrl::App(format!("toast.html?v={}", env!("CARGO_PKG_VERSION")).into()),
    )
    .title("Void Toast")
    .inner_size(TOAST_WIDTH as f64, TOAST_HEIGHT as f64)
    .position(x as f64, y as f64)
    .resizable(false)
    .decorations(false)
    // Tauri's default native shadow draws an extra 1px border around
    // undecorated windows on Windows. Keep only the HTML toast border.
    // No effect on Linux (shadow is compositor-controlled there).
    .shadow(false)
    .transparent(true)
    .skip_taskbar(true)
    .always_on_top(true)
    .visible_on_all_workspaces(true)
    .focused(false)
    // Sem `focusable(false)` o tao devolve accept-focus pra janela no primeiro
    // draw, e aí o `show()` tira o foco do jogo.
    .focusable(false)
    .visible(false)
    .build()?;

    apply_no_focus_hints(&win);

    #[cfg(target_os = "linux")]
    {
        use gtk::prelude::WidgetExt;

        // GTK may rewrite the window type as it maps the toplevel. Reapply the
        // ordered types while mapping, before the compositor paints the toast.
        win.gtk_window()?
            .connect_map(set_critical_notification_type);
    }

    Ok(win)
}

// ── Comandos IPC chamados pelo toast.html ─────────────────────────────────────

#[tauri::command]
fn toast_ready(app: AppHandle, state: State<'_, Mutex<AppState>>) -> Option<ToastParams> {
    eprintln!("[void-toast] toast_ready chamado");

    let params = state.lock().unwrap().params.clone();
    play_sound_async(params.sound.clone());

    if let Some(win) = app.get_webview_window("toast") {
        position_toast_window(&win);
        apply_no_focus_hints(&win);

        if let Err(err) = win.show() {
            eprintln!("[void-toast] erro ao mostrar toast: {:?}", err);
        }

        position_toast_window(&win);
        apply_no_focus_hints(&win);
    } else {
        eprintln!("[void-toast] janela toast não encontrada");
    }

    Some(params)
}

#[tauri::command]
fn hide_toast_window(app: AppHandle) -> Result<(), String> {
    eprintln!("[void-toast] hide_toast_window — encerrando processo");
    app.exit(0);
    Ok(())
}

// ── Ponto de entrada principal ─────────────────────────────────────────────────

pub fn run() {
    #[cfg(target_os = "linux")]
    unsafe {
        let allow_wayland = std::env::var("VOID_TOAST_ALLOW_WAYLAND")
            .map(|value| matches!(value.as_str(), "1" | "true" | "TRUE" | "yes" | "YES"))
            .unwrap_or(false);

        if !allow_wayland && std::env::var_os("DISPLAY").is_some() {
            // Wayland compositors commonly ignore window positioning and keep-above
            // hints. XWayland gives the toast predictable bottom-right placement.
            std::env::set_var("GDK_BACKEND", "x11");
            std::env::remove_var("WAYLAND_DISPLAY");
        }

        // Evita bug visual comum com WebKitGTK/AMD em janelas transparentes.
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");

        // Herdados do launcher: fazem o WM tratar o toast como "app recém-aberto"
        // e mover o foco pra ele, tirando o jogo da frente.
        std::env::remove_var("DESKTOP_STARTUP_ID");
        std::env::remove_var("XDG_ACTIVATION_TOKEN");
    }

    let args: Vec<String> = std::env::args().collect();

    let params = match parse_cli_params(&args) {
        Ok(params) => params,
        Err(err) => {
            eprintln!("[void-toast] erro: {}", err);
            eprintln!("[void-toast] use --help para ver os argumentos");
            std::process::exit(2);
        }
    };

    let duration_ms = params.duration.unwrap_or(DEFAULT_DURATION_MS);

    tauri::Builder::default()
        .manage(Mutex::new(AppState { params }))
        .invoke_handler(tauri::generate_handler![toast_ready, hide_toast_window])
        .setup(move |app| {
            let toast_win = create_toast_window(app)?;

            // Linux uses a persistent, empty GTK input region instead of Tao's
            // cursor-ignore request, so clicks pass through from the first map.
            position_toast_window(&toast_win);
            apply_no_focus_hints(&toast_win);

            let _ = toast_win.set_always_on_top(true);
            let _ = toast_win.set_visible_on_all_workspaces(true);

            // Fecha o processo automaticamente caso o JS não chame hide_toast_window.
            let handle = app.handle().clone();

            thread::spawn(move || {
                thread::sleep(Duration::from_millis(duration_ms + 1200));
                handle.exit(0);
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("erro ao executar void-toast");
}

// Evita warning se algum ambiente/toolchain reclamar de import não usado em builds específicos.
#[allow(dead_code)]
fn _exit_success() -> ExitCode {
    ExitCode::SUCCESS
}
