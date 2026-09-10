import {execFileSync} from 'node:child_process';
import {copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const root=path.dirname(fileURLToPath(import.meta.url));
const app=path.join(root,'build','有间桌面.app');
const contents=path.join(app,'Contents');
rmSync(app,{recursive:true,force:true});
mkdirSync(path.join(contents,'MacOS'),{recursive:true});
mkdirSync(path.join(contents,'Resources'),{recursive:true});
const assetsRoot=path.join(root,'assets');
const manifestPath=path.join(assetsRoot,'visual-catalog.json');
if(existsSync(manifestPath)){
  const manifest=JSON.parse(readFileSync(manifestPath,'utf8'));
  const referenced=new Set();
  for(const asset of manifest.assets??[]){
    if(asset.status!=='approved')continue;
    if(typeof asset.file==='string')referenced.add(asset.file);
    for(const file of Object.values(asset.recolorMasks??{}))if(typeof file==='string')referenced.add(file);
  }
  for(const scene of manifest.scenes??[]){
    if(scene.status==='ready'&&typeof scene.backgroundFile==='string')referenced.add(scene.backgroundFile);
  }
  for(const relative of referenced){
    const source=path.resolve(assetsRoot,relative), prefix=`${path.resolve(assetsRoot)}${path.sep}`;
    if(!source.startsWith(prefix)||!existsSync(source))throw new Error(`Manifest references missing or unsafe asset: ${relative}`);
    const destination=path.join(contents,'Resources',relative);
    mkdirSync(path.dirname(destination),{recursive:true}); copyFileSync(source,destination);
  }
  copyFileSync(manifestPath,path.join(contents,'Resources','visual-catalog.json'));
}
writeFileSync(path.join(contents,'Info.plist'),`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleName</key><string>有间桌面</string>
<key>CFBundleDisplayName</key><string>有间桌面</string>
<key>CFBundleIdentifier</key><string>local.youjian.desktop</string>
<key>CFBundleExecutable</key><string>YoujianDesktop</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>0.5.4</string>
<key>CFBundleVersion</key><string>11</string>
<key>LSMinimumSystemVersion</key><string>14.0</string>
<key>LSUIElement</key><true/>
<key>NSHighResolutionCapable</key><true/>
<key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
<key>NSMicrophoneUsageDescription</key><string>在有间聊天窗口中录制你主动发送的语音。</string>
</dict></plist>`);
execFileSync('/usr/bin/xcrun',['swiftc','-swift-version','5','-O','-target',`${process.arch==='arm64'?'arm64':'x86_64'}-apple-macosx14.0`,
  path.join(root,'CompanionCore.swift'),path.join(root,'AttentionGesture.swift'),path.join(root,'CharacterScene.swift'),path.join(root,'SceneImages.swift'),path.join(root,'PhotoPetView.swift'),path.join(root,'VisualStudio.swift'),path.join(root,'main.swift'),
  '-framework','AppKit','-framework','SceneKit','-framework','WebKit','-o',path.join(contents,'MacOS','YoujianDesktop')],{stdio:'inherit'});
execFileSync('/usr/bin/codesign',['--force','--sign','-',app],{stdio:'inherit'});
console.log(`已构建：${app}`);
if(process.argv.includes('--open'))execFileSync('/usr/bin/open',[app]);
