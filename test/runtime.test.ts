import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, symlinkSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { init, readConfig, writeConfig, readToken, acquireLock, privateDirectory } from '../src/runtime.js';

function removeTemporary(directory:string) {
  const full=resolve(directory),temporaryRoot=resolve(tmpdir());
  assert.ok(full.startsWith(temporaryRoot+sep),'cleanup must stay inside the temporary test directory');
  rmSync(full,{recursive:true,force:true});
}
function windowsScript(script:string,directory:string) {
  const command="$ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false);\n"+script;
  return execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(command,'utf16le').toString('base64')],{
    env:{...process.env,CODEX_DOTS_ACL_TEST_DIRECTORY:directory},encoding:'utf8',windowsHide:true,
  });
}
const aclSnapshot=String.raw`
$ErrorActionPreference='Stop'
$directory=[Environment]::GetEnvironmentVariable('CODEX_DOTS_ACL_TEST_DIRECTORY')
$paths=@($directory)+@([System.IO.Directory]::GetFiles($directory))
$items=@(foreach($path in $paths) {
  if([System.IO.Directory]::Exists($path)) {$acl=[System.IO.Directory]::GetAccessControl($path)}
  else {$acl=[System.IO.File]::GetAccessControl($path)}
  [pscustomobject]@{Name=[System.IO.Path]::GetFileName($path);IsDirectory=[System.IO.Directory]::Exists($path);Owner=$acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value;Protected=$acl.AreAccessRulesProtected;Rules=@(
    $acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]) | ForEach-Object {
      [pscustomobject]@{Sid=$_.IdentityReference.Value;Rights=[int]$_.FileSystemRights;Type=$_.AccessControlType.ToString();Inherited=$_.IsInherited;Inheritance=[int]$_.InheritanceFlags}
    }
  )}
})
[pscustomobject]@{User=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value;Items=$items}|ConvertTo-Json -Depth 5 -Compress
`;
interface AclSnapshot {User:string;Items:{Name:string;IsDirectory:boolean;Owner:string;Protected:boolean;Rules:{Sid:string;Rights:number;Type:string;Inherited:boolean;Inheritance:number}[]}[]}
function readAcl(directory:string):AclSnapshot {return JSON.parse(windowsScript(aclSnapshot,directory));}
function assertPrivateAcl(directory:string) {
  const snapshot=readAcl(directory);
  for(const item of snapshot.Items) {
    assert.ok([snapshot.User,'S-1-5-18'].includes(item.Owner),`allowed owner required for ${item.Name}`);
    assert.equal(item.Protected,true,item.Name);
    assert.deepEqual(item.Rules.map(rule=>rule.Sid).sort(),[snapshot.User,'S-1-5-18'].sort(),item.Name);
    for(const rule of item.Rules) {
      assert.equal(rule.Type,'Allow');assert.equal(rule.Rights,2032127);assert.equal(rule.Inherited,false);
      assert.equal(rule.Inheritance,item.IsDirectory?3:0);
    }
  }
}
function addBroadAcl(directory:string,includeFiles=false) {
  windowsScript(String.raw`
$ErrorActionPreference='Stop'
$directory=[Environment]::GetEnvironmentVariable('CODEX_DOTS_ACL_TEST_DIRECTORY')
$paths=@($directory)
`+(includeFiles?String.raw`$paths+=@([System.IO.Directory]::GetFiles($directory))`:'')+String.raw`
foreach($path in $paths) {
  $isDirectory=[System.IO.Directory]::Exists($path)
  if($isDirectory) {$acl=[System.IO.Directory]::GetAccessControl($path)}
  else {$acl=[System.IO.File]::GetAccessControl($path)}
  foreach($sid in @('S-1-1-0','S-1-5-32-545','S-1-5-21-100-200-300-400')) {
    $identity=[System.Security.Principal.SecurityIdentifier]::new($sid)
    $rights=[System.Security.AccessControl.FileSystemRights]::ReadAndExecute
    $allow=[System.Security.AccessControl.AccessControlType]::Allow
    if($isDirectory) {$rule=[System.Security.AccessControl.FileSystemAccessRule]::new($identity,$rights,[System.Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit',[System.Security.AccessControl.PropagationFlags]::None,$allow)}
    else {$rule=[System.Security.AccessControl.FileSystemAccessRule]::new($identity,$rights,$allow)}
    $acl.AddAccessRule($rule)
  }
  if($isDirectory) {[System.IO.Directory]::SetAccessControl($path,$acl)}
  else {[System.IO.File]::SetAccessControl($path,$acl)}
}
`,directory);
}

test('P0 init is idempotent, separates credentials, protects Windows ACL and handles spaces',()=>{
  const root=mkdtempSync(join(tmpdir(),'codex dots private ')),dir=join(root,'private data');
  try {
    const a=init(dir),caller=readToken(dir,'caller'),worker=readToken(dir,'worker');
    assert.ok(caller!==worker,'roles must have different credentials');assert.equal(init(dir).instance_id,a.instance_id);
    assert.ok(readToken(dir,'caller')===caller,'init must preserve the caller credential');assert.equal(readConfig(dir).owner,'codex-dots-bridge-p0');
    assert.ok(!readFileSync(join(dir,'config.json'),'utf8').includes(caller));
    if(process.platform==='win32') {
      assertPrivateAcl(dir);
    }
  } finally {removeTemporary(root);}
});

test('init refuses foreign data and does not overwrite files',()=>{
  const root=mkdtempSync(join(tmpdir(),'dots foreign '));
  try {writeFileSync(join(root,'keep.txt'),'preserve');assert.throws(()=>init(root),/unowned_data_directory/);assert.equal(readFileSync(join(root,'keep.txt'),'utf8'),'preserve');}
  finally {removeTemporary(root);}
});

test('exclusive service lock rejects a second process owner and removes only its own lock',()=>{
  const dir=mkdtempSync(join(tmpdir(),'dots lock '));
  try {
    const release=acquireLock(dir);assert.throws(()=>acquireLock(dir),/service_already_running/);release();
    const releaseAgain=acquireLock(dir);writeFileSync(join(dir,'service.lock'),JSON.stringify({pid:process.pid,owner:'different'}));releaseAgain();
    assert.ok(readFileSync(join(dir,'service.lock'),'utf8').includes('different'));
  } finally {removeTemporary(dir);}
});

test('local endpoint validation refuses remote addresses and credentials',()=>{
  const dir=mkdtempSync(join(tmpdir(),'dots endpoint '));
  try {
    const base={owner:'codex-dots-bridge-p0' as const,instance_id:'c05317de-bcce-43b6-bede-603dc90cf08c'};
    for(const endpoint of ['http://remote.example:1234/','https://127.0.0.1:1234/','http://user@127.0.0.1:1234/','http://127.0.0.1:1234/path']) {
      writeConfig(dir,{...base,endpoint});assert.throws(()=>readConfig(dir),/invalid_local_endpoint/);
    }
    writeConfig(dir,{...base,endpoint:'http://127.0.0.1:1234/'});assert.equal(readConfig(dir).endpoint,'http://127.0.0.1:1234/');
  } finally {removeTemporary(dir);}
});

test('Windows init removes explicit Everyone, Users and foreign-account ACEs from an existing empty directory',
  {skip:process.platform!=='win32'},()=>{
    const root=mkdtempSync(join(tmpdir(),'dots ACL regression ')),dir=join(root,"private 中文 O'Brien $literal");
    mkdirSync(dir);
    try {
      addBroadAcl(dir);
      const broad=readAcl(dir).Items[0]!.Rules.map(rule=>rule.Sid);
      for(const sid of ['S-1-1-0','S-1-5-32-545','S-1-5-21-100-200-300-400']) assert.ok(broad.includes(sid));
      init(dir);
      assertPrivateAcl(dir);
      assert.ok(/^[a-f0-9]{64}$/.test(readToken(dir,'caller')));
      assert.ok(/^[a-f0-9]{64}$/.test(readToken(dir,'worker')));
    } finally {removeTemporary(root);}
  });

test('Windows init repairs and verifies reused owned directory plus all known state-file ACLs without changing credentials',
  {skip:process.platform!=='win32'},()=>{
    const root=mkdtempSync(join(tmpdir(),'dots ACL owned ')),dir=join(root,'private');
    try {
      const original=init(dir),caller=readToken(dir,'caller'),worker=readToken(dir,'worker');
      for(const name of ['probe.sqlite','probe.sqlite-wal','probe.sqlite-shm','service.lock']) writeFileSync(join(dir,name),'synthetic state');
      addBroadAcl(dir,true);
      const ownersBefore=readAcl(dir).Items.map(item=>({name:item.Name,owner:item.Owner}));
      for(const item of readAcl(dir).Items) assert.ok(item.Rules.some(rule=>rule.Sid==='S-1-1-0'),item.Name);
      assert.equal(init(dir).instance_id,original.instance_id);
      assert.ok(readToken(dir,'caller')===caller,'caller credential must remain unchanged');
      assert.ok(readToken(dir,'worker')===worker,'worker credential must remain unchanged');
      assertPrivateAcl(dir);
      assert.deepEqual(readAcl(dir).Items.map(item=>({name:item.Name,owner:item.Owner})),ownersBefore,'ACL repair must preserve all known owners');
      for(const name of ['probe.sqlite','probe.sqlite-wal','probe.sqlite-shm','service.lock']) assert.equal(readFileSync(join(dir,name),'utf8'),'synthetic state');
    } finally {removeTemporary(root);}
  });

test('Windows ACL protection refuses unknown owned-directory materials before any ACL modification',
  {skip:process.platform!=='win32'},()=>{
    const root=mkdtempSync(join(tmpdir(),'dots ACL unknown ')),dir=join(root,'private');
    try {
      init(dir);writeFileSync(join(dir,'user-material.txt'),'preserve');addBroadAcl(dir,true);
      const before=readAcl(dir);
      assert.throws(()=>init(dir),/unexpected_data_directory_entry/);
      assert.deepEqual(readAcl(dir),before);
      assert.equal(readFileSync(join(dir,'user-material.txt'),'utf8'),'preserve');
    } finally {removeTemporary(root);}
  });

test('privateDirectory independently refuses foreign nonempty directories before changing ACLs',()=>{
  const dir=mkdtempSync(join(tmpdir(),'dots ACL foreign '));
  try {
    writeFileSync(join(dir,'keep.txt'),'preserve');
    const before=process.platform==='win32'?readAcl(dir):undefined;
    assert.throws(()=>privateDirectory(dir),/unowned_data_directory/);
    if(before) assert.deepEqual(readAcl(dir),before);
  } finally {removeTemporary(dir);}
});

test('Windows ACL repair rejects a known state-file junction without changing its unrelated target',
  {skip:process.platform!=='win32'},()=>{
    const root=mkdtempSync(join(tmpdir(),'dots ACL junction ')),dir=join(root,'private'),outside=join(root,'unrelated');
    try {
      init(dir);mkdirSync(outside);writeFileSync(join(outside,'keep.txt'),'preserve');
      const before=readAcl(outside);
      symlinkSync(outside,join(dir,'probe.sqlite'),'junction');
      assert.throws(()=>init(dir),/symlink_data_file/);
      assert.deepEqual(readAcl(outside),before);
      assert.equal(readFileSync(join(outside,'keep.txt'),'utf8'),'preserve');
    } finally {removeTemporary(root);}
  });
