// Exercises the production AppKit handlers and HTTP client against an isolated
// server. The self-check is injected into a temporary build, never the shipped app.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = path.dirname(fileURLToPath(import.meta.url));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'youjian-attention-check-'));
const requests = [], messages = [];
const server = http.createServer(async (req, res) => {
  const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (req.method === 'POST' && req.url === '/api/desktop/attention') {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); requests.push(body);
    if (requests.length === 1) return send(409, { error: '正在回复', code: 'ROLE_BUSY' });
    if (requests.length === 6) return send(409, { error: '已有更新消息', code: 'MODEL_CANCELLED' });
    const number = requests.length - 1;
    await new Promise(resolve => setTimeout(resolve, number === 2 ? 450 : 100));
    const rows = [{ id: `u-${number}`, speaker: 'user', text: '【桌面互动】' }, { id: `a-${number}`, speaker: 'assistant', text: `桌面关怀测试 ${number}` }];
    messages.push(...rows); return send(200, { messages: rows });
  }
  if (req.url === '/api/conversations/miyue') return send(200, { messages });
  if (req.url === '/api/inbox') return send(200, { items: [] });
  if (req.url?.startsWith('/api/')) return send(404, { error: 'fixture unavailable' });
  res.writeHead(200, { 'content-type': 'text/html;charset=utf-8' }); res.end('<p>桌面连接测试</p>');
});
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const contents = path.join(temp, 'AttentionCheck.app', 'Contents');
  fs.mkdirSync(path.join(contents, 'MacOS'), { recursive: true });
  fs.symlinkSync(path.join(root, 'assets'), path.join(contents, 'Resources'));
  fs.writeFileSync(path.join(contents, 'Info.plist'), `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>AttentionCheck</string><key>CFBundleIdentifier</key><string>local.youjian.attention-check</string><key>LSUIElement</key><true/><key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict></dict></plist>`);
  const check = `
    func checkAttentionFlow() async {
        func check(_ condition: Bool, _ message: String) {
            if !condition { fputs("Attention check failed: \\(message)\\n", stderr); exit(1) }
        }
        func pause(_ ms: Int) async { try? await Task.sleep(for: .milliseconds(ms)) }
        func click(_ view: NSView, _ count: Int) {
            let event = NSEvent.mouseEvent(with: .leftMouseDown, location: NSPoint(x: 100, y: 100), modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: panel.windowNumber, context: nil, eventNumber: count, clickCount: count, pressure: 1)!
            view.mouseDown(with: event); view.mouseUp(with: event)
        }
        func until(_ predicate: () -> Bool) async {
            for _ in 0..<180 { if predicate() { return }; await pause(50) }
            check(false, "condition timed out")
        }
        await pause(400)
        previewUntil = .distantPast
        for count in 1...4 { click(photoPet, count) }
        await pause(650)
        check(chatWindow == nil, "double-click opened chat")
        check(!bubble.isHidden, "pending bubble vanished")
        await until { lastMessage?.id == "a-1" }
        check(bubble.body.stringValue == "桌面关怀测试 1", "queued followup replaced first care reply")
        await until { lastMessage?.id == "a-2" && !attentionCoordinator.inFlight }
        check(tracker.pendingCount == 2, "immediate/poll duplicate")
        click(pet, 1); click(pet, 2)
        await until { lastMessage?.id == "a-3" && !attentionCoordinator.inFlight }
        click(sceneCanvas.uploadedView, 1); click(sceneCanvas.uploadedView, 2)
        await until { lastMessage?.id == "a-4" && !attentionCoordinator.inFlight }
        // The sixth HTTP call is MODEL_CANCELLED; queued affection must be cleared.
        for count in 1...4 { click(photoPet, count) }
        await until { !attentionCoordinator.inFlight }
        await pause(400)
        check(!attentionCoordinator.queuedAffection, "cancelled request retained affection")
        check(lastMessage?.id == "a-4", "cancelled request created a reply")
        click(photoPet, 1)
        await pause(Int(NSEvent.doubleClickInterval * 1000) + 150)
        check(chatWindow != nil, "single click no longer opens chat")
        check(isChatWindowVisible, "chat visibility state was not detected")
        bubble.show("visible chat", title: "test", message: true)
        check(bubble.isHidden, "visible chat did not suppress the desktop bubble")
        chatWindow?.miniaturize(nil)
        await until { chatWindow?.isMiniaturized == true }
        bubble.show("miniaturized chat", title: "test", message: true)
        check(!bubble.isHidden, "miniaturized chat suppressed a new desktop bubble")
        chatWindow?.deminiaturize(nil)
        await until { isChatWindowVisible }
        check(bubble.isHidden, "restoring chat did not hide the existing desktop bubble")
        bubble.show("unfocused visible chat", title: "test", message: true)
        check(bubble.isHidden, "restored chat did not suppress the desktop bubble")
        let closeItem = NSApp.mainMenu?.item(withTitle: "文件")?.submenu?.item(withTitle: "关闭窗口")
        check(closeItem?.action == #selector(NSWindow.performClose(_:)) && closeItem?.keyEquivalent == "w" && closeItem?.target == nil, "Command-W close menu is not routed through the window responder chain")
        check(NSApp.sendAction(#selector(NSWindow.performClose(_:)), to: nil, from: closeItem), "window close action was not handled")
        await until { !isChatWindowVisible }
        check(chatWindow != nil && web != nil, "closing chat discarded its page state")
        bubble.show("closed chat", title: "test", message: true)
        check(!bubble.isHidden, "closed chat suppressed a new desktop bubble")
        print("Native attention flow passed: all renderers, busy retry, queued affection, cancellation, single click")
        fflush(stdout); NSApp.terminate(nil)
    }
`;
  let source = fs.readFileSync(path.join(root, 'main.swift'), 'utf8');
  source = source.replace('    func endpoint(_ path: String)', check + '\n    func endpoint(_ path: String)');
  source = source.replace('        if snapshotsDirectory != nil { exportSnapshots() }', '        Task { @MainActor in await self.checkAttentionFlow() }\n        if snapshotsDirectory != nil { exportSnapshots() }');
  fs.writeFileSync(path.join(temp, 'main.swift'), source);
  const binary = path.join(contents, 'MacOS', 'AttentionCheck');
  execFileSync('/usr/bin/xcrun', ['swiftc', '-swift-version', '5', ...['CompanionCore.swift', 'AttentionGesture.swift', 'CharacterScene.swift', 'SceneImages.swift', 'PhotoPetView.swift', 'VisualStudio.swift'].map(file => path.join(root, file)), path.join(temp, 'main.swift'), '-framework', 'AppKit', '-framework', 'SceneKit', '-framework', 'WebKit', '-o', binary], { stdio: 'inherit' });
  await new Promise((resolve, reject) => {
    const child = spawn(binary, ['--test-profile', '--base-url', `http://127.0.0.1:${server.address().port}/`], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(Error('Native attention flow timed out')); }, 25_000);
    child.on('error', reject); child.on('exit', code => { clearTimeout(timer); if (code === 0) { console.log(output.trim()); resolve(); } else reject(Error(output)); });
  });
  assert.equal(requests.length, 6, 'cancelled request must not retry or dispatch retained affection');
  assert.equal(requests[0].requestId, requests[1].requestId, 'busy retries must reuse the request ID');
  assert.deepEqual(requests.map(r => r.level), ['care', 'care', 'affection', 'affection', 'affection', 'affection']);
  assert.equal(messages.length, 8);
  console.log('Native HTTP contract and saved message counts passed.');
} finally {
  await new Promise(resolve => server.close(resolve)); fs.rmSync(temp, { recursive: true, force: true });
}
