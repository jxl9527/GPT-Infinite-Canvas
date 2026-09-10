import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ProtocolError } from "@gpt-canvas/shared";

const execFileAsync = promisify(execFile);

const WINDOWS_FOLDER_PICKER_SCRIPT = String.raw`
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Windows.Forms
$dialog = [System.Windows.Forms.FolderBrowserDialog]::new()
$dialog.Description = '选择需要导入 D5 AI Canvas 的项目文件夹'
$dialog.ShowNewFolderButton = $false
$dialog.UseDescriptionForTitle = $true
try {
  if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
    [Console]::Out.Write($dialog.SelectedPath)
  }
} finally {
  $dialog.Dispose()
}
`;

export async function selectNativeProjectFolder(): Promise<string | null> {
  if (process.platform !== "win32") {
    throw new ProtocolError("INVALID_INPUT", "当前系统暂不支持原生文件夹选择，请粘贴绝对路径");
  }
  try {
    const { stdout } = await execFileAsync("pwsh.exe", [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-STA",
      "-Command",
      WINDOWS_FOLDER_PICKER_SCRIPT
    ], {
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 64 * 1024
    });
    const selectedPath = stdout.trim();
    return selectedPath || null;
  } catch (error) {
    if (error instanceof ProtocolError) throw error;
    throw new ProtocolError("INVALID_INPUT", "无法打开系统文件夹选择器，请改用绝对路径导入");
  }
}
