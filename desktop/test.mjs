import {execFileSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.dirname(fileURLToPath(import.meta.url));
const temp=mkdtempSync(path.join(os.tmpdir(),'youjian-desktop-tests-'));
try {
  const binary=path.join(temp,'core-tests');
  execFileSync('/usr/bin/xcrun',['swiftc',path.join(root,'CompanionCore.swift'),path.join(root,'AttentionGesture.swift'),path.join(root,'SceneImages.swift'),path.join(root,'PhotoPetView.swift'),path.join(root,'CoreTests.swift'),'-framework','AppKit','-o',binary],{stdio:'inherit'});
  execFileSync(binary,['--assets-root',path.join(root,'assets')],{stdio:'inherit'});
} finally {rmSync(temp,{recursive:true,force:true});}
