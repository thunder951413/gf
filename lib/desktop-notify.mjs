import { execFile } from 'node:child_process';
import fs from 'node:fs';

export const desktopNotificationsAvailable = process.platform === 'darwin' && fs.existsSync('/usr/bin/osascript');

// Only fixed, non-private text enters AppleScript. The model cannot choose commands,
// notification content, recipients, or links. Display ultimately depends on macOS.
export async function notifyDesktop() {
  if (!desktopNotificationsAvailable) return { requested: false, error: '当前系统不支持本地桌面提醒' };
  return new Promise(resolve => {
    execFile('/usr/bin/osascript', ['-e', 'display notification "有一个新话题等你，打开有间就可以继续聊。" with title "有间有新消息"'], { timeout: 8000 }, error => {
      resolve(error ? { requested: false, error: '系统未能接收桌面提醒，请检查通知设置' } : { requested: true });
    });
  });
}
