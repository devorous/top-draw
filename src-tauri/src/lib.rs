use std::{fs, path::Path, process::Command};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::Serialize;
use tauri::{
  menu::MenuBuilder,
  tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
  Manager,
};

#[derive(Serialize)]
struct NativeImageSelection {
  name: String,
  data_url: String,
}

#[derive(Serialize)]
struct SaveDialogResult {
  saved: bool,
  path: Option<String>,
}

#[cfg(target_os = "windows")]
fn powershell_single_quote(value: &str) -> String {
  value.replace('\'', "''")
}

#[cfg(target_os = "windows")]
fn run_powershell(script: &str) -> Result<String, String> {
  let output = Command::new("powershell")
    .args(["-NoProfile", "-NonInteractive", "-Sta", "-Command", script])
    .output()
    .map_err(|error| format!("Failed to launch PowerShell: {error}"))?;

  if !output.status.success() {
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    return Err(if stderr.is_empty() {
      format!("PowerShell exited with status {}", output.status)
    } else {
      stderr
    });
  }

  Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

#[cfg(target_os = "windows")]
fn show_open_image_dialog() -> Result<Option<String>, String> {
  let script = r#"
    Add-Type -AssemblyName System.Windows.Forms
    $dialog = New-Object System.Windows.Forms.OpenFileDialog
    $dialog.Filter = 'Image Files|*.png;*.jpg;*.jpeg;*.gif;*.bmp;*.webp'
    $dialog.Multiselect = $false
    if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
      [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
      Write-Output $dialog.FileName
    }
  "#;

  let output = run_powershell(script)?;
  if output.is_empty() {
    Ok(None)
  } else {
    Ok(Some(output))
  }
}

#[cfg(target_os = "windows")]
fn show_save_png_dialog(suggested_name: &str) -> Result<Option<String>, String> {
  let escaped_name = powershell_single_quote(suggested_name);
  let script = format!(
    r#"
      Add-Type -AssemblyName System.Windows.Forms
      $dialog = New-Object System.Windows.Forms.SaveFileDialog
      $dialog.Filter = 'PNG Image|*.png'
      $dialog.FileName = '{escaped_name}'
      if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {{
        [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
        Write-Output $dialog.FileName
      }}
    "#
  );

  let output = run_powershell(&script)?;
  if output.is_empty() {
    Ok(None)
  } else {
    Ok(Some(output))
  }
}

#[cfg(not(target_os = "windows"))]
fn show_open_image_dialog() -> Result<Option<String>, String> {
  Err("Native image import is currently implemented for Windows only".into())
}

#[cfg(not(target_os = "windows"))]
fn show_save_png_dialog(_suggested_name: &str) -> Result<Option<String>, String> {
  Err("Native image export is currently implemented for Windows only".into())
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
    .separator()
    .text("quit", "Quit")
    .build()?;

  let mut tray = TrayIconBuilder::new()
    .menu(&menu)
    .tooltip("Ddraw")
    .show_menu_on_left_click(false)
    .on_menu_event(|app, event| match event.id().as_ref() {
      "show" => reveal_main_window(app),
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_log::Builder::default().build())
    .plugin(tauri_plugin_shell::init())
    .invoke_handler(tauri::generate_handler![open_image_via_dialog, save_png_via_dialog])
    .setup(|app| {
      build_tray(app)?;

      #[cfg(debug_assertions)]
      {
        let main_window = app.get_webview_window("main").unwrap();
        main_window.open_devtools();
      }

      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
