use std::{
  fs,
  path::Path,
  sync::Mutex,
  thread,
  time::Duration,
};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use discord_rich_presence::{activity, DiscordIpc, DiscordIpcClient};
use log::{info, warn};
use serde::Serialize;
use tauri::{
  menu::MenuBuilder,
  tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
  AppHandle, Emitter, Manager, State,
};
use tauri_plugin_updater::{Update, UpdaterExt};

const UPDATER_ENDPOINT: Option<&str> = option_env!("TAURI_UPDATER_ENDPOINT");
const UPDATER_PUBLIC_KEY: Option<&str> = option_env!("TAURI_UPDATER_PUBLIC_KEY");
const DISCORD_APP_ID: &str = "1492446544882958386";
const DISCORD_PRESENCE_OPTIONS: [&str; 4] = [
  "is doodling",
  "is drawing",
  "is sketching",
  "is scribbling"
];

struct PendingUpdate(Mutex<Option<Update>>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeImageSelection {
  name: String,
  data_url: String,
}

#[derive(Serialize)]
struct SaveDialogResult {
  saved: bool,
  path: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateMetadata {
  version: String,
  current_version: String,
  notes: Option<String>,
  date: Option<String>,
}

fn show_open_image_dialog() -> Result<Option<String>, String> {
  Ok(
    rfd::FileDialog::new()
      .add_filter("Image Files", &["png", "jpg", "jpeg", "gif", "bmp", "webp"])
      .pick_file()
      .map(|path| path.to_string_lossy().to_string()),
  )
}

fn show_save_png_dialog(suggested_name: &str) -> Result<Option<String>, String> {
  Ok(
    rfd::FileDialog::new()
      .add_filter("PNG Image", &["png"])
      .set_file_name(suggested_name)
      .save_file()
      .map(|path| path.to_string_lossy().to_string()),
  )
}

fn image_mime_for_path(path: &Path) -> &'static str {
  match path
    .extension()
    .and_then(|ext| ext.to_str())
    .map(|ext| ext.to_ascii_lowercase())
    .as_deref()
  {
    Some("jpg") | Some("jpeg") => "image/jpeg",
    Some("gif") => "image/gif",
    Some("bmp") => "image/bmp",
    Some("webp") => "image/webp",
    _ => "image/png",
  }
}

fn reveal_main_window(app: &tauri::AppHandle) {
  if let Some(window) = app.get_webview_window("main") {
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
  }
}

fn build_tray(app: &tauri::App) -> tauri::Result<()> {
  let menu = MenuBuilder::new(app)
    .text("show", "Show Ddraw")
    .text("open-chat", "Open Chat")
    .separator()
    .text("quit", "Quit")
    .build()?;

  let mut tray = TrayIconBuilder::new()
    .menu(&menu)
    .tooltip("Ddraw")
    .show_menu_on_left_click(false)
    .on_menu_event(|app, event| match event.id().as_ref() {
      "show" => reveal_main_window(app),
      "open-chat" => {
        if let Some(chat_window) = app.get_webview_window("chat-popout") {
          let _ = chat_window.show();
          let _ = chat_window.unminimize();
          let _ = chat_window.set_focus();
        } else {
          reveal_main_window(app);
          if let Some(main_window) = app.get_webview_window("main") {
            let _ = main_window.emit("open-chat", ());
          }
        }
      }
      "quit" => app.exit(0),
      _ => {}
    })
    .on_tray_icon_event(|tray, event| {
      if let TrayIconEvent::Click {
        button: MouseButton::Left,
        button_state: MouseButtonState::Up,
        ..
      } = event
      {
        reveal_main_window(&tray.app_handle());
      }
    });

  if let Some(icon) = app.default_window_icon().cloned() {
    tray = tray.icon(icon);
  }

  tray.build(app)?;
  Ok(())
}

fn updater_configuration() -> Option<(String, String)> {
  let endpoint = UPDATER_ENDPOINT?.trim();
  let pubkey = UPDATER_PUBLIC_KEY?.trim();

  if endpoint.is_empty() || pubkey.is_empty() {
    return None;
  }

  Some((endpoint.to_string(), pubkey.to_string()))
}

fn start_discord_presence() {
  thread::spawn(|| {
    let random_index = std::time::SystemTime::now()
      .duration_since(std::time::UNIX_EPOCH)
      .map(|duration| duration.subsec_nanos() as usize % DISCORD_PRESENCE_OPTIONS.len())
      .unwrap_or(0);
    let activity = activity::Activity::new().state(DISCORD_PRESENCE_OPTIONS[random_index]);

    loop {
      let mut client = match DiscordIpcClient::new(DISCORD_APP_ID) {
        Ok(client) => client,
        Err(error) => {
          warn!("Failed to create Discord IPC client: {error}");
          thread::sleep(Duration::from_secs(30));
          continue;
        }
      };

      if let Err(error) = client.connect() {
        warn!("Discord Rich Presence unavailable: {error}");
        thread::sleep(Duration::from_secs(30));
        continue;
      }

      if let Err(error) = client.set_activity(activity.clone()) {
        warn!("Failed to set Discord Rich Presence activity: {error}");
        let _ = client.close();
        thread::sleep(Duration::from_secs(30));
        continue;
      }

      info!("Discord Rich Presence connected.");

      loop {
        thread::sleep(Duration::from_secs(60));

        if let Err(error) = client.set_activity(activity.clone()) {
          warn!("Discord Rich Presence disconnected: {error}");
          let _ = client.close();
          break;
        }
      }
    }
  });
}

#[tauri::command]
fn open_image_via_dialog() -> Result<Option<NativeImageSelection>, String> {
  let Some(path) = show_open_image_dialog()? else {
    return Ok(None);
  };

  let bytes = fs::read(&path).map_err(|error| format!("Failed to read image: {error}"))?;
  let name = Path::new(&path)
    .file_name()
    .and_then(|value| value.to_str())
    .unwrap_or("image.png")
    .to_string();
  let mime = image_mime_for_path(Path::new(&path));
  let data_url = format!("data:{mime};base64,{}", BASE64.encode(bytes));

  Ok(Some(NativeImageSelection { name, data_url }))
}

#[tauri::command]
fn save_png_via_dialog(base64_png: String, suggested_name: Option<String>) -> Result<SaveDialogResult, String> {
  let suggested_name = suggested_name.unwrap_or_else(|| "drawing.png".to_string());
  let Some(path) = show_save_png_dialog(&suggested_name)? else {
    return Ok(SaveDialogResult {
      saved: false,
      path: None,
    });
  };

  let bytes = BASE64
    .decode(base64_png.trim())
    .map_err(|error| format!("Failed to decode PNG data: {error}"))?;

  fs::write(&path, bytes).map_err(|error| format!("Failed to save image: {error}"))?;

  Ok(SaveDialogResult {
    saved: true,
    path: Some(path),
  })
}

#[tauri::command]
async fn fetch_update(app: AppHandle, pending_update: State<'_, PendingUpdate>) -> Result<Option<UpdateMetadata>, String> {
  let Some((endpoint, pubkey)) = updater_configuration() else {
    return Ok(None);
  };

  let update = app
    .updater_builder()
    .endpoints(vec![
      endpoint
        .parse()
        .map_err(|error| format!("Invalid update endpoint: {error}"))?
    ])
    .map_err(|error| format!("Failed to configure update endpoint: {error}"))?
    .pubkey(pubkey)
    .build()
    .map_err(|error| format!("Failed to prepare update check: {error}"))?
    .check()
    .await
    .map_err(|error| format!("Failed to check for updates: {error}"))?;

  let metadata = update.as_ref().map(|update| UpdateMetadata {
    version: update.version.clone(),
    current_version: update.current_version.clone(),
    notes: update.body.clone(),
    date: update.date.as_ref().and_then(|dt| {
      dt.format(&time::format_description::well_known::Rfc3339).ok()
    }),
  });

  let mut pending = pending_update
    .0
    .lock()
    .map_err(|_| "Failed to store pending update state.".to_string())?;
  *pending = update;

  Ok(metadata)
}

#[tauri::command]
async fn install_update(pending_update: State<'_, PendingUpdate>) -> Result<(), String> {
  let update = {
    let mut pending = pending_update
      .0
      .lock()
      .map_err(|_| "Failed to access pending update state.".to_string())?;
    pending.take()
  };

  let Some(update) = update else {
    return Err("No pending update is available.".into());
  };

  update
    .download_and_install(|_, _| {}, || {})
    .await
    .map_err(|error| format!("Failed to install update: {error}"))?;

  Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  let mut builder = tauri::Builder::default()
    .plugin(tauri_plugin_log::Builder::default().build())
    .plugin(tauri_plugin_shell::init())
    .plugin(tauri_plugin_process::init())
    .invoke_handler(tauri::generate_handler![
      open_image_via_dialog,
      save_png_via_dialog,
      fetch_update,
      install_update
    ]);

  if updater_configuration().is_some() {
    builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
  }

  builder
    .setup(|app| {
      app.manage(PendingUpdate(Mutex::new(None)));
      build_tray(app)?;
      start_discord_presence();

      #[cfg(debug_assertions)]
      {
        let main_window = app.get_webview_window("main").unwrap();
        main_window.open_devtools();
      }

      Ok(())
    })
    .on_window_event(|window, event| {
      if let tauri::WindowEvent::Destroyed = event {
        if window.label() == "main" {
          if let Some(chat_window) = window.app_handle().get_webview_window("chat-popout") {
            let _ = chat_window.close();
          }
          if let Some(board_viewer_window) = window.app_handle().get_webview_window("board-viewer-popout") {
            let _ = board_viewer_window.close();
          }
        }
      }
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
