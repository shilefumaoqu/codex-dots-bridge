import { spawn, type ChildProcess } from 'node:child_process';
import { ProbeError } from './store.js';
export function isolatedEnvironment():NodeJS.ProcessEnv {
  const env:NodeJS.ProcessEnv={};for(const name of ['SystemRoot','WINDIR','ComSpec','PATH','Path','TEMP','TMP','LOCALAPPDATA','APPDATA','USERPROFILE','PROGRAMFILES','PROGRAMDATA','HOME'])if(process.env[name])env[name]=process.env[name];return env;
}

// Windows 10+ creates the Tunnel inside the Job atomically. Only the guardian owns
// the Job handle, so guardian death closes it and kills the entire Tunnel tree.
// Documentation: https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute
const guardianScript=String.raw`
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)
try {
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.Collections;
using System.Collections.Generic;
using System.Linq;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;
public static class CodexDotsTunnelJob {
 [StructLayout(LayoutKind.Sequential)] struct BasicLimit {public long ProcessTime,JobTime;public uint Flags;public UIntPtr MinWorking,MaxWorking;public uint ActiveProcesses;public UIntPtr Affinity;public uint Priority,Scheduling;}
 [StructLayout(LayoutKind.Sequential)] struct IoCounters {public ulong ReadOps,WriteOps,OtherOps,ReadBytes,WriteBytes,OtherBytes;}
 [StructLayout(LayoutKind.Sequential)] struct ExtendedLimit {public BasicLimit Basic;public IoCounters Io;public UIntPtr ProcessMemory,JobMemory,PeakProcessMemory,PeakJobMemory;}
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct Startup {public uint cb;public string reserved,desktop,title;public uint x,y,xsize,ysize,xcount,ycount,fill,flags;public ushort show,reserved2;public IntPtr reservedPtr,input,output,error;}
 [StructLayout(LayoutKind.Sequential)] struct StartupEx {public Startup startup;public IntPtr attributes;}
 [StructLayout(LayoutKind.Sequential)] struct ProcessInfo {public IntPtr process,thread;public uint pid,tid;}
 [StructLayout(LayoutKind.Sequential)] struct Security {public int length;public IntPtr descriptor;[MarshalAs(UnmanagedType.Bool)] public bool inherit;}
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateJobObjectW(IntPtr security,string name);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int kind,ref ExtendedLimit limits,uint size);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list,int count,uint flags,ref IntPtr size);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list,uint flags,IntPtr attribute,IntPtr value,IntPtr size,IntPtr previous,IntPtr returned);
 [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcessW(string application,StringBuilder command,IntPtr processSecurity,IntPtr threadSecurity,bool inherit,uint flags,IntPtr environment,string directory,ref StartupEx startup,out ProcessInfo process);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateFileW(string path,uint access,uint share,ref Security security,uint creation,uint flags,IntPtr template);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
 [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle,uint timeout);
 static string Quote(string value) {var result=new StringBuilder("\"");int slashes=0;foreach(char c in value){if(c=='\\'){slashes++;continue;}if(c=='\"'){result.Append(new string('\\',slashes*2+1));result.Append(c);}else{result.Append(new string('\\',slashes));result.Append(c);}slashes=0;}result.Append(new string('\\',slashes*2));result.Append('\"');return result.ToString();}
 static void Require(bool ok){if(!ok)throw new Exception("native_launch_failed");}
 public static void Run(string executable,string[] args,string keyFile) {
  IntPtr job=IntPtr.Zero,list=IntPtr.Zero,jobValue=IntPtr.Zero,nullValue=IntPtr.Zero,environment=IntPtr.Zero,nul=IntPtr.Zero;ProcessInfo child=new ProcessInfo();bool attributesReady=false;
  try {
   if(Environment.GetEnvironmentVariable("CONTROL_PLANE_API_KEY")!=null||Environment.GetEnvironmentVariable("OPENAI_API_KEY")!=null)throw new Exception("guardian_environment_not_isolated");
   job=CreateJobObjectW(IntPtr.Zero,null);Require(job!=IntPtr.Zero);
   ExtendedLimit limits=new ExtendedLimit();limits.Basic.Flags=0x2000;
   Require(SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf(typeof(ExtendedLimit))));
   IntPtr size=IntPtr.Zero;InitializeProcThreadAttributeList(IntPtr.Zero,2,0,ref size);Require(size!=IntPtr.Zero);
   list=Marshal.AllocHGlobal(size);Require(InitializeProcThreadAttributeList(list,2,0,ref size));attributesReady=true;
   jobValue=Marshal.AllocHGlobal(IntPtr.Size);Marshal.WriteIntPtr(jobValue,job);
   Require(UpdateProcThreadAttribute(list,0,new IntPtr(0x2000D),jobValue,new IntPtr(IntPtr.Size),IntPtr.Zero,IntPtr.Zero));
   Security security=new Security();security.length=Marshal.SizeOf(typeof(Security));security.inherit=true;
   nul=CreateFileW("NUL",0xC0000000,3,ref security,3,0,IntPtr.Zero);Require(nul!=new IntPtr(-1));
   nullValue=Marshal.AllocHGlobal(IntPtr.Size);Marshal.WriteIntPtr(nullValue,nul);
   Require(UpdateProcThreadAttribute(list,0,new IntPtr(0x20002),nullValue,new IntPtr(IntPtr.Size),IntPtr.Zero,IntPtr.Zero));
   var values=new SortedDictionary<string,string>(StringComparer.OrdinalIgnoreCase);
   foreach(string name in new[]{"SystemRoot","WINDIR","ComSpec","PATH","TEMP","TMP","LOCALAPPDATA","APPDATA","USERPROFILE","PROGRAMFILES","PROGRAMDATA","HOME"}){var value=Environment.GetEnvironmentVariable(name);if(value!=null)values[name]=value;}
   var contents=File.ReadAllText(keyFile);if(contents.Length>16384)throw new Exception("invalid_key_file");
   var lines=contents.TrimStart('\uFEFF').Split(new[]{'\r','\n'},StringSplitOptions.RemoveEmptyEntries).Where(line=>line.Trim().Length>0&&!line.Trim().StartsWith("#")).ToArray();
   if(lines.Length!=1||!lines[0].StartsWith("CONTROL_PLANE_API_KEY="))throw new Exception("invalid_key_file");
   var key=lines[0].Substring(22).Trim();if(key.Length>=2&&((key[0]=='\"'&&key[key.Length-1]=='\"')||(key[0]=='\''&&key[key.Length-1]=='\'')))key=key.Substring(1,key.Length-2);
   if(key.Length==0||key.Any(Char.IsWhiteSpace))throw new Exception("invalid_key_file");values["CONTROL_PLANE_API_KEY"]=key;
   environment=Marshal.StringToHGlobalUni(string.Join("\0",values.Select(pair=>pair.Key+"="+pair.Value))+"\0\0");
   var startup=new StartupEx();startup.startup.cb=(uint)Marshal.SizeOf(typeof(StartupEx));startup.startup.flags=0x100;startup.startup.input=nul;startup.startup.output=nul;startup.startup.error=nul;startup.attributes=list;
   var command=new StringBuilder(string.Join(" ",new[]{executable}.Concat(args).Select(Quote)));
   Require(CreateProcessW(executable,command,IntPtr.Zero,IntPtr.Zero,true,0x00080000|0x08000000|0x00000400,environment,Path.GetDirectoryName(executable),ref startup,out child));
   CloseHandle(child.thread);child.thread=IntPtr.Zero;
   Console.Out.WriteLine("{\"type\":\"tunnel_ready\",\"pid\":"+child.pid+",\"guardian_key_present\":false}");Console.Out.Flush();
   // Tunnel inherits only NUL, so it cannot keep the supervisor-to-guardian pipe open.
   var parent=Task.Factory.StartNew(()=>Console.In.ReadLine());
   while(!parent.IsCompleted&&WaitForSingleObject(child.process,0)==258)Thread.Sleep(100);
  } finally {
   if(job!=IntPtr.Zero)CloseHandle(job);
   if(child.process!=IntPtr.Zero){WaitForSingleObject(child.process,5000);CloseHandle(child.process);}
   if(child.thread!=IntPtr.Zero)CloseHandle(child.thread);
   if(attributesReady)DeleteProcThreadAttributeList(list);
   if(list!=IntPtr.Zero)Marshal.FreeHGlobal(list);
   if(jobValue!=IntPtr.Zero)Marshal.FreeHGlobal(jobValue);
   if(nullValue!=IntPtr.Zero)Marshal.FreeHGlobal(nullValue);
   if(environment!=IntPtr.Zero)Marshal.FreeHGlobal(environment);
   if(nul!=IntPtr.Zero&&nul!=new IntPtr(-1))CloseHandle(nul);
  }
 }
}
'@
$config=[Environment]::GetEnvironmentVariable('CODEX_DOTS_GUARDIAN_CONFIG')|ConvertFrom-Json
[CodexDotsTunnelJob]::Run($config.executable,[string[]]$config.args,$config.key_file)
exit 0
} catch { [Console]::Out.WriteLine('{"type":"guardian_error"}');exit 1 }
`;

export interface TunnelGuardian {process:ChildProcess;ready:Promise<number>}
export function launchWindowsTunnel(executable:string,args:string[],keyFile:string):TunnelGuardian {
  if(process.platform!=='win32'||process.arch!=='x64')throw new ProbeError('tunnel_guardian_windows_x64_only');
  const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(guardianScript,'utf16le').toString('base64')],{windowsHide:true,stdio:['pipe','pipe','ignore'],env:{...isolatedEnvironment(),CODEX_DOTS_GUARDIAN_CONFIG:JSON.stringify({executable,args,key_file:keyFile})}});
  child.stdin?.on('error',()=>{/* EOF/EPIPE is expected when either owner exits. */});
  const ready=new Promise<number>((resolve,reject)=>{
    let text='';const timer=setTimeout(()=>{child.stdin?.end();reject(new ProbeError('tunnel_guardian_start_timeout'));},45000);
    const fail=()=>{clearTimeout(timer);reject(new ProbeError('tunnel_guardian_start_failed'));};
    child.once('error',fail);child.once('exit',fail);
    child.stdout?.on('data',(chunk:Buffer)=>{text+=chunk.toString('utf8');if(text.length>2048){child.stdin?.end();fail();return;}let newline:number;while((newline=text.indexOf('\n'))>=0){const line=text.slice(0,newline).trim();text=text.slice(newline+1);try{const message=JSON.parse(line) as {type:string;pid?:number};if(message.type==='tunnel_ready'&&Number.isSafeInteger(message.pid)&&message.pid!>0){clearTimeout(timer);child.removeListener('error',fail);child.removeListener('exit',fail);resolve(message.pid!);}else if(message.type==='guardian_error')fail();}catch{fail();}}});
  });
  return {process:child,ready};
}
