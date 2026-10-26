// .NET Framework 4.8 / C# 5. Uses only framework WinForms, Drawing and Web.Extensions.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Globalization;
using System.IO;
using System.Net;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Win32;

namespace CodexDotsBridge.Tray
{
    internal sealed class Options
    {
        public string DataDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "CodexDotsBridge", "data");
        public string StateFile, Screenshot, Theme = "auto";
        public bool Exit, Running, SelfTest, Version, Preview, Hidden;
        public static Options Parse(string[] args)
        {
            Options o = new Options();
            for (int i = 0; i < args.Length; i++)
            {
                switch (args[i])
                {
                    case "--data-dir": o.DataDir = Value(args, ref i); break;
                    case "--state-file": o.StateFile = Value(args, ref i); break;
                    case "--screenshot": o.Screenshot = Value(args, ref i); break;
                    case "--theme": o.Theme = Value(args, ref i); break;
                    case "--exit": o.Exit = true; break;
                    case "--running": o.Running = true; break;
                    case "--self-test": o.SelfTest = true; break;
                    case "--version": o.Version = true; break;
                    case "--preview": o.Preview = true; break;
                    case "--hidden": case "--background": o.Hidden = true; break;
                    case "--show": o.Hidden = false; break;
                    default: throw new ArgumentException("unknown_option");
                }
            }
            o.DataDir = NormalizePath(o.DataDir);
            if (o.Theme != "auto" && o.Theme != "light" && o.Theme != "dark") throw new ArgumentException("invalid_theme");
            if (!o.Preview && (o.StateFile != null || o.Screenshot != null || o.Theme != "auto")) throw new ArgumentException("preview_required");
            return o;
        }
        static string Value(string[] args, ref int i) { if (++i >= args.Length) throw new ArgumentException("missing_option_value"); return args[i]; }
        public static string NormalizePath(string value)
        {
            string full = Path.GetFullPath(value);
            string root = Path.GetPathRoot(full);
            return full.Length > root.Length ? full.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar) : full;
        }
    }

    internal sealed class Snapshot
    {
        public string InstalledVersion, ServiceVersion, State = "unknown", Tone = "amber", Title = "正在检查", Reason = "正在读取当前连接状态。";
        public string Service = "未检查", Cloud = "未检查", Dot = "未检查", Control = "disabled", Autostart = "unknown", Error;
        public DateTimeOffset? CheckedAt, LastBusinessAt, AutostartCheckedAt;
        public string WaitingReason;
        public int? Inflight;
        public Dictionary<string, int> Counts = new Dictionary<string, int>();
        static readonly string[] CountKeys = { "queued", "running", "waiting_input", "cancel_requested", "reconciliation_required", "completed", "failed", "cancelled", "expired" };
        public static string VersionText(string value) { return value != null && Regex.IsMatch(value, @"\A[0-9A-Za-z.+-]{1,80}\z") ? value : null; }
        static string Text(Dictionary<string, object> d, string key, int limit)
        {
            object v; if (!d.TryGetValue(key, out v) || !(v is string)) throw new FormatException("invalid_projection");
            string s = (string)v;
            // The projection is generated locally, but reject paths, multiline text and long arbitrary payloads.
            if (s.Length > limit || s.IndexOfAny(new char[] { '\r', '\n', '\0', '\\', '/' }) >= 0) throw new FormatException("invalid_projection");
            return s;
        }
        static int? Number(object value)
        {
            if (value == null) return null;
            if (!(value is int) && !(value is long)) throw new FormatException("invalid_projection");
            long n = Convert.ToInt64(value, CultureInfo.InvariantCulture);
            if (n < 0 || n > Int32.MaxValue) throw new FormatException("invalid_projection");
            return (int)n;
        }
        public static Snapshot Parse(string json)
        {
            JavaScriptSerializer serializer = new JavaScriptSerializer(); serializer.MaxJsonLength = 131072;
            Dictionary<string, object> d = serializer.Deserialize<Dictionary<string, object>>(json);
            object value;
            if (d == null || !d.TryGetValue("schema", out value) || Number(value) != 1) throw new FormatException("invalid_schema");
            Snapshot s = new Snapshot();
            s.State = Text(d, "state", 60); s.Tone = Text(d, "tone", 8); s.Title = Text(d, "title", 60); s.Reason = Text(d, "reason", 180);
            s.Service = Text(d, "service", 60); s.Cloud = Text(d, "cloud", 60); s.Dot = Text(d, "dot", 60);
            s.Control = Text(d, "control", 12); s.Autostart = Text(d, "autostart", 12);
            if (s.Tone != "green" && s.Tone != "amber" && s.Tone != "red" && s.Tone != "gray") throw new FormatException("invalid_tone");
            if (s.Control != "start" && s.Control != "stop" && s.Control != "disabled") throw new FormatException("invalid_control");
            if (s.Autostart != "enabled" && s.Autostart != "disabled" && s.Autostart != "unknown") throw new FormatException("invalid_autostart");
            if (!d.TryGetValue("installed_version", out value)) throw new FormatException("invalid_projection"); s.InstalledVersion = VersionText(value as string);
            if (!d.TryGetValue("service_version", out value)) throw new FormatException("invalid_projection"); s.ServiceVersion = VersionText(value as string);
            if (!d.TryGetValue("inflight_count", out value)) throw new FormatException("invalid_projection"); s.Inflight = Number(value);
            string at = Text(d, "checked_at", 50); DateTimeOffset parsed;
            if (!DateTimeOffset.TryParse(at, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out parsed)) throw new FormatException("invalid_checked_at");
            if (Math.Abs((DateTimeOffset.UtcNow - parsed).TotalSeconds) > 45) throw new FormatException("stale_projection");
            s.CheckedAt = parsed;
            if (d.TryGetValue("autostart_checked_at", out value) && value != null)
            {
                if (!(value is string) || !DateTimeOffset.TryParse((string)value, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out parsed)) throw new FormatException("invalid_autostart_time");
                s.AutostartCheckedAt = parsed;
                if (Math.Abs((DateTimeOffset.UtcNow - parsed).TotalSeconds) > 45) s.Autostart = "unknown";
            }
            if (d.TryGetValue("last_business_at", out value) && value != null)
            {
                if (!(value is string) || !DateTimeOffset.TryParse((string)value, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out parsed) || parsed > DateTimeOffset.UtcNow.AddSeconds(5)) throw new FormatException("invalid_business_time");
                s.LastBusinessAt = parsed;
            }
            if (d.TryGetValue("waiting_reason", out value) && value != null)
            {
                switch (value as string)
                {
                    case "execution_slot_occupied": s.WaitingReason = "执行槽占用，任务排队中"; break;
                    case "queued_behind_task": s.WaitingReason = "正在等待前面的任务"; break;
                    case "route_unavailable": s.WaitingReason = "任务路由不可用，请检查连接"; break;
                    case "event_delivery_failed": s.WaitingReason = "事件投递受阻，请检查连接"; break;
                    case "awaiting_delivery": s.WaitingReason = "正在等待事件投递"; break;
                    case "awaiting_pickup": s.WaitingReason = "事件已接收，正在等待 Dot 领取"; break;
                    case "pickup_delayed": s.WaitingReason = "Dot 领取延迟"; break;
                    case "pickup_stalled": s.WaitingReason = "Dot 尚未领取，请检查连接或路由"; break;
                    case "execution_unverified": s.WaitingReason = "执行状态待核对，请检查原任务"; break;
                    case "deadline_elapsed": s.WaitingReason = "任务期限已到，请核对原任务"; break;
                    default: throw new FormatException("invalid_waiting_reason");
                }
            }
            if (!d.TryGetValue("error", out value)) throw new FormatException("invalid_projection");
            if (value != null) { string code = value as string; if (code == null || !Regex.IsMatch(code, @"\A[a-zA-Z0-9_:-]{1,100}\z")) throw new FormatException("invalid_error"); s.Error = code; }
            if (!d.TryGetValue("task_counts", out value)) throw new FormatException("invalid_projection");
            Dictionary<string, object> counts = value as Dictionary<string, object>;
            if (counts == null) throw new FormatException("invalid_task_counts");
            foreach (string key in CountKeys) { object n; if (counts.TryGetValue(key, out n)) { int? count = Number(n); if (!count.HasValue) throw new FormatException("invalid_task_count"); s.Counts[key] = count.Value; } }
            // A healthy projection must carry running-service version evidence.
            if (s.Tone == "green" && (s.Control != "stop" || s.ServiceVersion == null)) throw new FormatException("untrusted_ready_projection");
            return s;
        }
        public Snapshot ForPreview() { CheckedAt = DateTimeOffset.UtcNow; return this; }
        public string DisplayReason()
        {
            string text = Reason;
            if (WaitingReason != null) text += "\n" + WaitingReason;
            if (LastBusinessAt.HasValue) text += "\n最近业务事件 " + LastBusinessAt.Value.ToLocalTime().ToString("yyyy-MM-dd HH:mm:ss") + "（不代表当前任务完成）";
            return text;
        }
        public static Snapshot Unknown(Snapshot last, string error)
        {
            Snapshot s = new Snapshot(); s.Title = "状态未知"; s.Reason = error == "status_timeout" ? "检查超时，请刷新后重试。" : "未取得可靠状态，请刷新后重试。"; s.Error = error;
            if (last != null) { s.InstalledVersion = last.InstalledVersion; s.ServiceVersion = last.ServiceVersion; s.CheckedAt = last.CheckedAt; }
            return s;
        }
        public void CheckVersions(string trayVersion)
        {
            bool mismatch = InstalledVersion != null && trayVersion != null && InstalledVersion != trayVersion;
            mismatch |= ServiceVersion != null && InstalledVersion != null && ServiceVersion != InstalledVersion;
            mismatch |= ServiceVersion != null && trayVersion != null && ServiceVersion != trayVersion;
            if (mismatch && Tone != "red" && State != "unknown") { Tone = "amber"; Title = "版本未同步"; Reason = "界面、安装或后台版本不同，请使用同一版本的维护入口。"; }
        }
        public string Diagnostics(string trayVersion, string effectiveTitle = null)
        {
            StringBuilder b = new StringBuilder("Codex Dots Bridge\r\n");
            b.AppendLine("托盘版本: " + (trayVersion ?? "未取得")); b.AppendLine("安装版本: " + (InstalledVersion ?? "未取得")); b.AppendLine("后台版本: " + (ServiceVersion ?? "未取得"));
            b.AppendLine("状态: " + (effectiveTitle ?? Title)); b.AppendLine("本机服务: " + Service); b.AppendLine("云端连接: " + Cloud); b.AppendLine("Dot 订阅: " + Dot);
            b.AppendLine("登录自启: " + Autostart); b.AppendLine("检查时间: " + (CheckedAt.HasValue ? CheckedAt.Value.ToString("o") : "未取得"));
            b.AppendLine("自启检查时间: " + (AutostartCheckedAt.HasValue ? AutostartCheckedAt.Value.ToString("o") : "未取得"));
            b.AppendLine("错误码: " + (Error ?? "无")); b.AppendLine("在途任务数: " + (Inflight.HasValue ? Inflight.Value.ToString(CultureInfo.InvariantCulture) : "未取得"));
            b.AppendLine("状态说明: " + Reason);
            if (WaitingReason != null) b.AppendLine("任务等待: " + WaitingReason);
            b.AppendLine("最近业务事件: " + (LastBusinessAt.HasValue ? LastBusinessAt.Value.ToString("o") : "未取得"));
            foreach (string key in CountKeys) if (Counts.ContainsKey(key)) b.AppendLine("任务 " + key + ": " + Counts[key].ToString(CultureInfo.InvariantCulture));
            b.Append("连接状态不证明任务或消息已成功。" ); return b.ToString();
        }
    }

    internal sealed class CommandResult { public string Output, Error; public bool TimedOut; public int ExitCode; }
    // Polling has no CLI or child-process path. Lifecycle commands continue to use
    // Cli below. The endpoint, credential, instance and observation are all bound
    // to the same local installation before a response can reach the UI.
    internal sealed class StatusClient
    {
        const int Limit = 131072, Timeout = 3000;
        readonly string root, dataDir;
        sealed class Local
        {
            public Dictionary<string, object> Config, Hint, Lock, ServiceLock;
            public string ConfigText, HintText, LockText, ServiceText, Instance, Endpoint;
        }
        public StatusClient(string root, string dataDir) { this.root = Options.NormalizePath(root); this.dataDir = Options.NormalizePath(dataDir); }
        static string Text(Dictionary<string, object> value, string key) { object item; return value != null && value.TryGetValue(key, out item) ? item as string : null; }
        static Dictionary<string, object> Object(Dictionary<string, object> value, string key) { object item; return value != null && value.TryGetValue(key, out item) ? item as Dictionary<string, object> : null; }
        static bool True(Dictionary<string, object> value, string key) { object item; return value != null && value.TryGetValue(key, out item) && item is bool && (bool)item; }
        static int Pid(Dictionary<string, object> value, string key)
        {
            object item; if (value == null || !value.TryGetValue(key, out item) || (!(item is int) && !(item is long))) return 0;
            long n = Convert.ToInt64(item, CultureInfo.InvariantCulture); return n > 0 && n <= Int32.MaxValue ? (int)n : 0;
        }
        static bool SamePath(string left, string right) { return left != null && right != null && String.Equals(Options.NormalizePath(left), Options.NormalizePath(right), StringComparison.OrdinalIgnoreCase); }
        static void Safe(string path)
        {
            for (string current = Path.GetFullPath(path); !String.IsNullOrEmpty(current); current = Path.GetDirectoryName(current))
            {
                try { if ((File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0) throw new FormatException("unsafe_local_state"); }
                catch (FileNotFoundException) { }
                catch (DirectoryNotFoundException) { }
            }
        }
        static byte[] Bounded(Stream stream)
        {
            using (MemoryStream output = new MemoryStream())
            {
                byte[] buffer = new byte[4096]; int count;
                while ((count = stream.Read(buffer, 0, Math.Min(buffer.Length, Limit + 1 - (int)output.Length))) > 0)
                { output.Write(buffer, 0, count); if (output.Length > Limit) throw new FormatException("projection_too_large"); }
                return output.ToArray();
            }
        }
        static byte[] FileBytes(string path)
        {
            Safe(path);
            try { using (FileStream stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete)) return Bounded(stream); }
            catch (FileNotFoundException) { return null; }
            catch (DirectoryNotFoundException) { return null; }
        }
        static string FileText(string path) { byte[] bytes = FileBytes(path); return bytes == null ? null : new UTF8Encoding(false, true).GetString(bytes).TrimStart('\uFEFF'); }
        static Dictionary<string, object> Json(string text)
        {
            if (text == null) return null;
            JavaScriptSerializer serializer = new JavaScriptSerializer(); serializer.MaxJsonLength = Limit;
            Dictionary<string, object> value = serializer.Deserialize<Dictionary<string, object>>(text);
            if (value == null) throw new FormatException("invalid_local_state"); return value;
        }
        static Uri Endpoint(string text)
        {
            Uri uri;
            if (!Uri.TryCreate(text, UriKind.Absolute, out uri) || uri.Scheme != "http" || uri.Host != "127.0.0.1" || uri.Port < 1 || uri.IsDefaultPort ||
                uri.AbsolutePath != "/" || uri.Query.Length != 0 || uri.Fragment.Length != 0 || uri.UserInfo.Length != 0 ||
                !Regex.IsMatch(text, @"\Ahttp://127\.0\.0\.1:[0-9]+/\z")) throw new FormatException("invalid_local_endpoint");
            return new Uri(uri, "control/tray_status");
        }
        Local ReadLocal()
        {
            Local state = new Local(); state.ConfigText = FileText(Path.Combine(dataDir, "config.json")); state.Config = Json(state.ConfigText);
            Guid instance; string id = Text(state.Config, "instance_id");
            if (Text(state.Config, "owner") != "codex-dots-bridge" || !Guid.TryParseExact(id, "D", out instance) ||
                (Pid(state.Config, "schema_version") != 1 && Pid(state.Config, "schema_version") != 2)) throw new FormatException("invalid_local_config");
            state.Instance = instance.ToString("D"); state.Endpoint = Text(state.Config, "endpoint"); if (state.Endpoint != null) Endpoint(state.Endpoint);
            Dictionary<string, object> installation = Object(state.Config, "installation");
            if (installation != null && !SamePath(Text(installation, "root"), root)) throw new FormatException("installation_binding_mismatch");
            state.HintText = FileText(Path.Combine(dataDir, "supervisor-state.json")); state.Hint = Json(state.HintText);
            state.LockText = FileText(Path.Combine(dataDir, "supervisor.lock")); state.Lock = Json(state.LockText);
            state.ServiceText = FileText(Path.Combine(dataDir, "service.lock")); state.ServiceLock = Json(state.ServiceText);
            if (state.Hint != null && (String.IsNullOrEmpty(Text(state.Hint, "owner")) || Pid(state.Hint, "pid") == 0)) throw new FormatException("invalid_local_state");
            if (state.Lock != null && (state.Hint == null || Text(state.Lock, "owner") != Text(state.Hint, "owner") || Pid(state.Lock, "pid") != Pid(state.Hint, "pid"))) throw new FormatException("supervisor_ownership_mismatch");
            if (state.ServiceLock != null && (String.IsNullOrEmpty(Text(state.ServiceLock, "owner")) || Pid(state.ServiceLock, "pid") == 0)) throw new FormatException("service_identity_unverified");
            return state;
        }
        static int Presence(int pid)
        {
            if (pid < 1) return -1;
            try { using (Process process = Process.GetProcessById(pid)) return process.HasExited ? 0 : 1; }
            catch (ArgumentException) { return 0; }
            catch { return -1; }
        }
        static bool AllGone(Local state)
        {
            if (state.Lock == null || Text(state.Hint, "phase") != "running" || True(state.Hint, "cleanup_complete") || Pid(state.Hint, "bridge_pid") == 0) return false;
            if (state.ServiceLock != null && (Pid(state.ServiceLock, "pid") != Pid(state.Hint, "bridge_pid") || Text(state.ServiceLock, "owner") == Text(state.Hint, "owner"))) return false;
            foreach (string key in new string[] { "pid", "bridge_pid", "guardian_pid", "tunnel_pid" })
                if (state.Hint.ContainsKey(key) && Presence(Pid(state.Hint, key)) != 0) return false;
            return true;
        }
        bool LauncherOwned(string launcher)
        {
            string payload = Path.GetDirectoryName(root), install = Path.GetDirectoryName(payload);
            if (Path.GetFileName(payload) != "payload" || !SamePath(launcher, Path.Combine(install, "CodexDotsBridge.Launcher.exe"))) return false;
            Safe(launcher); if (!File.Exists(launcher) || new FileInfo(launcher).Length > 32 * 1024 * 1024) return false;
            Dictionary<string, object> state = Json(FileText(Path.Combine(install, "installation-state.json")));
            if (Text(state, "owner") != "codex-dots-bridge-setup" || Pid(state, "schema") != 1 || !SamePath(Text(state, "install_directory"), install) || !SamePath(Text(state, "payload_root"), root) || !SamePath(Text(state, "data_dir"), dataDir)) return false;
            using (SHA256 hash = SHA256.Create())
            using (FileStream stream = File.OpenRead(launcher))
                return Text(state, "launcher_sha256") == BitConverter.ToString(hash.ComputeHash(stream)).Replace("-", "").ToLowerInvariant();
        }
        string Autostart(Local state)
        {
            try
            {
                Dictionary<string, object> manifest = Json(FileText(Path.Combine(dataDir, "installation.json")));
                if (Text(manifest, "owner") != "codex-dots-bridge" || Text(manifest, "instance_id") != state.Instance) return "unknown";
                Dictionary<string, object> mcp = Object(manifest, "mcp"); object argsValue;
                if (mcp == null || Text(mcp, "name") != "codex-dots-bridge" || !mcp.TryGetValue("args", out argsValue)) return "unknown";
                System.Collections.IList args = argsValue as System.Collections.IList; if (args == null || args.Count != 4 || (string)args[1] != "stdio" || (string)args[2] != "--data-dir" || !SamePath(args[3] as string, dataDir) || !SamePath(args[0] as string, Path.Combine(root, "dist", "main.js"))) return "unknown";
                Dictionary<string, object> entry = Object(manifest, "autostart");
                string launcher = Text(manifest, "autostart_launcher"), kind = Text(entry, "kind");
                if (launcher != null && !LauncherOwned(launcher)) return "unknown";
                bool link = launcher != null && (entry == null || kind == "startup-link");
                string name = link ? "CodexDotsBridge.lnk" : "CodexDotsBridge.vbs";
                string path = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Startup), name);
                byte[] bytes = FileBytes(path); if (bytes == null) return "disabled";
                if (entry == null || !SamePath(Text(entry, "path"), path) || Text(entry, "content") != (link ? Convert.ToBase64String(bytes) : new UTF8Encoding(false, true).GetString(bytes))) return "unknown";
                if (link && !SamePath(Text(entry, "launcher"), launcher)) return "unknown";
                if (launcher == null) return "enabled";
                using (RegistryKey key = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\StartupFolder", false))
                {
                    object value = key == null ? null : key.GetValue(name); if (value == null) return "enabled";
                    byte[] approval = value as byte[]; if (approval == null || approval.Length < 12) return "unknown";
                    return approval[0] == 2 || approval[0] == 6 ? "enabled" : approval[0] == 3 || approval[0] == 7 ? "disabled" : "unknown";
                }
            }
            catch { return "unknown"; }
        }
        CommandResult Offline(Local local, string error, bool processGone)
        {
            string state = "unknown", tone = "amber", title = "状态未知", reason = "暂时无法核验当前服务状态", control = "disabled", service = "待确认";
            if (True(local.Hint, "cleanup_complete") && local.Lock == null && local.ServiceLock == null)
            {
                bool failed = Text(local.Hint, "error") != null || Text(local.Hint, "phase") == "failed";
                state = failed ? "failed" : "stopped"; tone = failed ? "red" : "gray"; title = failed ? "后台故障" : "后台已停止";
                reason = failed ? "后台报告故障，需要检查" : "后台已停止，可随时启动"; control = "start"; service = "已停止"; error = failed ? "supervisor_failed" : null;
                if (Text(local.Hint, "error") == "bridge_start_failed" || Text(local.Hint, "error") == "supervisor_spawn_failed") { title = "启动失败"; reason = "后台启动未成功，请检查连接设置"; }
            }
            else if (local.Hint == null && local.Lock == null && local.ServiceLock == null && local.Endpoint == null)
            {
                bool setup = Object(local.Config, "tunnel") == null; state = setup ? "setup" : "stopped"; tone = setup ? "amber" : "gray";
                title = setup ? "等待连接设置" : "后台已停止"; reason = setup ? "请完成连接配置" : "后台已停止，可随时启动"; control = "start"; service = "已停止"; error = null;
            }
            else if (processGone && AllGone(local))
            {
                state = "failed"; tone = "red"; title = "后台连接中断"; reason = "记录的后台进程均已退出，可启动恢复；启动时会重新核验安全条件";
                control = "start"; service = "连接已中断"; error = "background_connection_lost";
            }
            else if (local.Lock != null && Text(local.Hint, "phase") == "starting") { state = "starting"; title = "正在启动"; reason = "服务正在启动，请稍候"; service = "正在启动"; }
            else if (local.Lock != null && Text(local.Hint, "phase") == "stopping")
            {
                string stopPath = Path.Combine(dataDir, "supervisor.stop");
                Dictionary<string, object> stop = Json(FileText(stopPath));
                bool old = stop != null && (DateTime.UtcNow - File.GetLastWriteTimeUtc(stopPath)).TotalSeconds > 35;
                state = old ? "stop_unconfirmed" : "stopping"; title = old ? "停止尚未确认" : "正在停止";
                reason = old ? "停止请求已发出，清理结果尚未确认" : "正在等待服务完成清理"; service = "正在停止";
            }
            else if (local.Lock != null && Text(local.Hint, "phase") == "failed")
            {
                state = "failed"; tone = "red"; title = "后台故障"; reason = "后台报告故障，需要检查"; service = "后台故障";
                if (Text(local.Hint, "error") == "bridge_start_failed" || Text(local.Hint, "error") == "supervisor_spawn_failed") { title = "启动失败"; reason = "后台启动未成功，请检查连接设置"; }
            }
            string now = DateTimeOffset.UtcNow.ToString("o");
            return new CommandResult { Output = new JavaScriptSerializer().Serialize(new { schema = 1, instance_id = local.Instance, installed_version = Program.Version,
                service_version = (string)null, state = state, tone = tone, title = title, reason = reason, control = control, service = service, cloud = "未检查", dot = "未检查",
                autostart = Autostart(local), autostart_checked_at = now, checked_at = now, task_counts = new Dictionary<string, int>(), inflight_count = (int?)null, error = error }) };
        }
        public Task<CommandResult> Read()
        {
            return Task.Run(delegate
            {
                try
                {
                    Local local = ReadLocal(); int presence = local.ServiceLock == null ? 0 : Presence(Pid(local.ServiceLock, "pid"));
                    if (local.Endpoint == null || presence != 1) return Offline(local, presence < 0 ? "service_identity_unverified" : "service_not_running", presence == 0);
                    string token = FileText(Path.Combine(dataDir, "caller.key")); token = token == null ? null : token.Trim();
                    if (token == null || !Regex.IsMatch(token, @"\A[a-f0-9]{64}\z")) return new CommandResult { Error = "invalid_local_credential", ExitCode = -1 };
                    HttpWebRequest request = (HttpWebRequest)WebRequest.Create(Endpoint(local.Endpoint));
                    request.Proxy = null; request.AllowAutoRedirect = false; request.Method = "POST"; request.ContentType = "application/json";
                    request.Headers[HttpRequestHeader.Authorization] = "Bearer " + token; request.Timeout = Timeout; request.ReadWriteTimeout = Timeout;
                    request.ContentLength = 2; request.ServicePoint.Expect100Continue = false;
                    // Abort is an overall deadline, including a server that drips body bytes.
                    using (System.Threading.Timer deadline = new System.Threading.Timer(delegate { request.Abort(); }, null, Timeout, System.Threading.Timeout.Infinite))
                    {
                        try
                        {
                            using (Stream body = request.GetRequestStream()) body.Write(new byte[] { 123, 125 }, 0, 2);
                            string json;
                            using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
                            {
                                if (response.StatusCode != HttpStatusCode.OK || response.ContentLength > Limit) return new CommandResult { Error = "invalid_projection", ExitCode = -1 };
                                using (Stream stream = response.GetResponseStream()) json = new UTF8Encoding(false, true).GetString(Bounded(stream));
                            }
                            Dictionary<string, object> projection = Json(json); Guid instance;
                            if (!Guid.TryParseExact(Text(projection, "instance_id"), "D", out instance) || instance.ToString("D") != local.Instance) return new CommandResult { Error = "service_identity_unverified", ExitCode = -1 };
                            Snapshot snapshot = Snapshot.Parse(json); // Includes the observation-time check.
                            if (snapshot.InstalledVersion == null) return new CommandResult { Error = "service_version_unavailable", ExitCode = -1 };
                            Local current = ReadLocal();
                            if (current.ConfigText != local.ConfigText || current.LockText != local.LockText || current.ServiceText != local.ServiceText ||
                                Text(current.Hint, "owner") != Text(local.Hint, "owner") || Pid(current.Hint, "pid") != Pid(local.Hint, "pid")) return new CommandResult { Error = "local_identity_changed", ExitCode = -1 };
                            return new CommandResult { Output = json };
                        }
                        catch (WebException error)
                        {
                            if (error.Response != null) error.Response.Dispose();
                            bool timeout = error.Status == WebExceptionStatus.Timeout || error.Status == WebExceptionStatus.RequestCanceled;
                            // Re-read hints so a completed stop can safely expose Start. Never
                            // convert reachability alone (or a live PID) to readiness.
                            return Offline(ReadLocal(), timeout ? "status_timeout" : "local_service_unreachable", false);
                        }
                    }
                }
                catch { return new CommandResult { Error = "invalid_local_projection", ExitCode = -1 }; }
            });
        }
    }
    internal sealed class Cli
    {
        public readonly string Root, DataDir;
        public Cli(string root, string dataDir) { Root = root; DataDir = dataDir; }
        public static string Quote(string value)
        {
            // CommandLineToArgvW quoting: double backslashes before a quote and at the closing quote.
            StringBuilder b = new StringBuilder("\""); int slashes = 0;
            foreach (char c in value) { if (c == '\\') { slashes++; continue; } if (c == '"') { b.Append('\\', slashes * 2 + 1); b.Append(c); } else { b.Append('\\', slashes); b.Append(c); } slashes = 0; }
            b.Append('\\', slashes * 2); b.Append('"'); return b.ToString();
        }
        public Task<CommandResult> Run(string arguments, int timeoutMs, bool diagnostic)
        {
            return Task.Run(delegate
            {
                string node = Path.Combine(Root, "runtime", "node-v24.21.0-win-x64", "node.exe");
                if (!File.Exists(node)) node = Path.Combine(Root, ".runtime", "node-v24.21.0-win-x64", "node.exe");
                string main = Path.Combine(Root, "dist", "main.js");
                if (!File.Exists(node) || !File.Exists(main)) return new CommandResult { Error = "runtime_unavailable", ExitCode = -1 };
                Process p = new Process(); StringBuilder stdout = new StringBuilder(); object gate = new object(); bool oversized = false, outputEnded = false;
                p.StartInfo = new ProcessStartInfo(node, Quote(main) + " " + arguments + " --data-dir " + Quote(DataDir));
                p.StartInfo.WorkingDirectory = Root; p.StartInfo.UseShellExecute = false; p.StartInfo.CreateNoWindow = true; p.StartInfo.WindowStyle = ProcessWindowStyle.Hidden;
                p.StartInfo.RedirectStandardOutput = true; p.StartInfo.RedirectStandardError = true; p.StartInfo.StandardOutputEncoding = Encoding.UTF8;
                p.OutputDataReceived += delegate(object sender, DataReceivedEventArgs e) { lock (gate) { if (e.Data == null) { outputEnded = true; Monitor.PulseAll(gate); } else if (stdout.Length + e.Data.Length < 131072) stdout.AppendLine(e.Data); else oversized = true; } };
                // Never persist or render stderr, which may contain credentials or private paths.
                p.ErrorDataReceived += delegate { };
                try
                {
                    Stopwatch budget = Stopwatch.StartNew(); p.Start(); p.BeginOutputReadLine(); p.BeginErrorReadLine();
                    if (!p.WaitForExit(timeoutMs))
                    {
                        if (diagnostic) { try { p.Kill(); p.WaitForExit(1000); } catch { } p.Dispose(); }
                        else Task.Run(delegate { try { p.WaitForExit(); } catch { } finally { p.Dispose(); } });
                        return new CommandResult { TimedOut = true, Error = diagnostic ? "status_timeout" : "operation_unconfirmed", ExitCode = -1 };
                    }
                    // Drain without an unbounded WaitForExit(), which can wait on inherited stdout pipes.
                    int exitCode = p.ExitCode; string output;
                    lock (gate)
                    {
                        int remaining = Math.Max(0, timeoutMs - (int)budget.ElapsedMilliseconds);
                        if (!outputEnded && remaining > 0) Monitor.Wait(gate, Math.Min(1000, remaining));
                        output = outputEnded ? stdout.ToString() : null;
                    }
                    p.Dispose();
                    if (output == null) return new CommandResult { Error = "projection_incomplete", ExitCode = exitCode };
                    return new CommandResult { Output = oversized ? null : output, ExitCode = exitCode, Error = oversized ? "projection_too_large" : exitCode == 0 ? null : "cli_failed" };
                }
                catch { p.Dispose(); return new CommandResult { Error = "cli_unavailable", ExitCode = -1 }; }
            });
        }
    }

    internal static class Program
    {
        public static readonly string Version = GetVersion();
        static string GetVersion() { AssemblyInformationalVersionAttribute a = (AssemblyInformationalVersionAttribute)Attribute.GetCustomAttribute(Assembly.GetExecutingAssembly(), typeof(AssemblyInformationalVersionAttribute)); return Snapshot.VersionText(a == null ? null : a.InformationalVersion); }
        public static string InstanceKey(string dataDir)
        {
            string identity = WindowsIdentity.GetCurrent().User.Value + "\n" + Options.NormalizePath(dataDir).ToUpperInvariant();
            using (SHA256 hash = SHA256.Create()) return BitConverter.ToString(hash.ComputeHash(Encoding.UTF8.GetBytes(identity))).Replace("-", "");
        }
        [STAThread]
        public static int Main(string[] args)
        {
            try
            {
                Options o = Options.Parse(args);
                if (o.Version) { Console.WriteLine(new JavaScriptSerializer().Serialize(new { tray_version = Version })); return 0; }
                if (o.SelfTest) return SelfTest();
                Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
                if (o.Preview) { using (BridgeForm preview = new BridgeForm(o, null, null)) Application.Run(preview); return 0; }
                string key = "Local\\CodexDotsBridge.Tray." + InstanceKey(o.DataDir);
                bool created;
                using (Mutex mutex = new Mutex(true, key, out created))
                {
                    if (!created)
                    {
                        // Presence of a kernel object alone is not proof of a live UI owner.
                        try { created = mutex.WaitOne(0); } catch (AbandonedMutexException) { created = true; }
                    }
                    if (!created)
                    {
                        if (o.Running) return 0;
                        bool delivered = Signal(key + (o.Exit ? ".Exit" : ".Show"));
                        if (!delivered) return 2;
                        if (o.Exit) { try { if (!mutex.WaitOne(10000)) return 3; } catch (AbandonedMutexException) { } mutex.ReleaseMutex(); }
                        return 0;
                    }
                    if (o.Exit || o.Running) { mutex.ReleaseMutex(); return o.Exit ? 0 : 1; }
                    using (EventWaitHandle show = new EventWaitHandle(false, EventResetMode.AutoReset, key + ".Show"))
                    using (EventWaitHandle exit = new EventWaitHandle(false, EventResetMode.AutoReset, key + ".Exit"))
                    using (BridgeForm form = new BridgeForm(o, show, exit)) Application.Run(new TrayContext(form, !o.Hidden));
                    mutex.ReleaseMutex();
                }
                return 0;
            }
            catch { Console.WriteLine("{\"error\":\"tray_initialization_failed\"}"); return 2; }
        }
        static bool Signal(string name)
        {
            for (int i = 0; i < 20; i++) { try { using (EventWaitHandle ev = EventWaitHandle.OpenExisting(name)) ev.Set(); return true; } catch (WaitHandleCannotBeOpenedException) { Thread.Sleep(50); } }
            return false;
        }
        static int SelfTest()
        {
            int n = 0; Action<bool> check = delegate(bool ok) { if (!ok) throw new Exception("self_test_failed"); n++; };
            check(Cli.Quote("plain") == "\"plain\""); check(Cli.Quote("a b") == "\"a b\""); check(Cli.Quote("a\"b") == "\"a\\\"b\""); check(Cli.Quote("C:\\dir\\") == "\"C:\\dir\\\\\"");
            check(InstanceKey("C:\\demo\\") == InstanceKey("c:\\demo")); check(InstanceKey("C:\\demo") != InstanceKey("C:\\demo2"));
            Snapshot ready = Snapshot.Parse(Example("ready", "green", "stop", "enabled", "0.2.0-alpha.20", 2)); check(ready.Inflight == 2); check(ready.Tone == "green");
            ready.CheckVersions("0.2.0-alpha.19"); check(ready.Title == "版本未同步"); check(ready.Tone == "amber");
            Snapshot unknown = Snapshot.Unknown(ready, "status_timeout"); check(unknown.Control == "disabled"); check(unknown.Tone == "amber"); check(!unknown.Inflight.HasValue); check(unknown.CheckedAt == ready.CheckedAt);
            Snapshot stopped = Snapshot.Parse(Example("stopped", "gray", "start", "disabled", null, null)); stopped.CheckVersions("0.2.0-alpha.20"); check(stopped.Tone == "gray"); check(stopped.Autostart == "disabled"); check(!stopped.Inflight.HasValue);
            foreach (string autostart in new string[] { "enabled", "disabled", "unknown" }) check(Snapshot.Parse(Example("unknown", "amber", "disabled", autostart, null, null)).Autostart == autostart);
            string injected = Example("unknown", "amber", "disabled", "unknown", null, null).Replace("未检查", "C:\\\\Users\\\\private"); bool refused = false;
            try { Snapshot.Parse(injected); } catch (FormatException) { refused = true; } check(refused);
            string stale = Example("ready", "green", "stop", "enabled", "0.2.0-alpha.20", 0).Replace(DateTimeOffset.UtcNow.ToString("yyyy-MM-dd"), "2000-01-01"); refused = false;
            try { Snapshot.Parse(stale); } catch (FormatException) { refused = true; } check(refused);
            stopped.Reason = "最近启动记录：supervisor_recovery_recovery_probe_failed";
            string diagnostics = stopped.Diagnostics("0.2.0-alpha.20"); check(!diagnostics.Contains("C:\\")); check(!diagnostics.Contains("task_id")); check(diagnostics.Contains(stopped.Reason));
            Console.WriteLine(new JavaScriptSerializer().Serialize(new { passed = n, backend_calls = 0 })); return 0;
        }
        static string Example(string state, string tone, string control, string autostart, string serviceVersion, int? inflight)
        {
            return new JavaScriptSerializer().Serialize(new { schema = 1, installed_version = "0.2.0-alpha.20", service_version = serviceVersion, state = state, tone = tone, title = state == "stopped" ? "后台已停止" : "连接就绪", reason = "", service = "未检查", cloud = "未检查", dot = "未检查", control = control, autostart = autostart, checked_at = DateTimeOffset.UtcNow.ToString("o"), task_counts = new Dictionary<string, int>(), inflight_count = inflight, error = (string)null });
        }
    }

    internal sealed class TrayContext : ApplicationContext
    {
        readonly BridgeForm form;
        public TrayContext(BridgeForm f, bool show) { form = f; f.Disposed += delegate { ExitThread(); }; f.Exiting += delegate { ExitThread(); }; IntPtr unused = f.Handle; f.Initialize(); if (show) f.OpenWindow(); }
        protected override void ExitThreadCore() { form.Shutdown(); base.ExitThreadCore(); }
    }

    internal sealed class BridgeForm : Form
    {
        public event EventHandler Exiting;
        readonly Options options; readonly Cli cli; readonly EventWaitHandle showEvent, exitEvent;
        Func<Task<CommandResult>> statusReader;
        RegisteredWaitHandle showWait, exitWait;
        readonly System.Windows.Forms.Timer poll = new System.Windows.Forms.Timer();
        readonly NotifyIcon tray = new NotifyIcon(); readonly ContextMenuStrip menu = new ContextMenuStrip();
        readonly Label heading = new Label(), reason = new Label(), service = new Label(), cloud = new Label(), dot = new Label(), versions = new Label(), autostart = new Label(), checkedAt = new Label();
        readonly Button control = new PremiumButton(), refresh = new PremiumButton(); readonly LinkLabel copy = new LinkLabel();
        readonly PremiumButton closeButton = new PremiumButton(); readonly Label wordmark = new Label(); readonly PictureBox brandView = new PictureBox();
        readonly StatusBadge statusBadge = new StatusBadge(); readonly RoundedPanel components = new RoundedPanel(); readonly TableLayoutPanel header = new TableLayoutPanel();
        readonly ToolStripMenuItem controlItem = new ToolStripMenuItem(), autoItem = new ToolStripMenuItem();
        readonly TableLayoutPanel outer = new TableLayoutPanel(), footer = new TableLayoutPanel();
        Snapshot state = new Snapshot(); Image brand; Icon currentIcon; bool checking, queuedRefresh, refreshFollowup, commandBusy, shuttingDown, initialized, dark;
        Task refreshTask;
        string pendingControl, pendingAutostart, actionNote, iconTone; DateTime lastCheck = DateTime.MinValue;
        float presentationScale = 1F;
        bool presentationFontsInitialized, layoutDirty = true;
        readonly List<PresentationToken> presentationTokens = new List<PresentationToken>();
        readonly List<Font> originalPresentationFonts = new List<Font>();
        List<Font> currentPresentationFonts = new List<Font>();
        readonly Dictionary<ToolStripItem, Padding> menuItemPadding = new Dictionary<ToolStripItem, Padding>();
        int generation; uint explorerMessage;
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern uint RegisterWindowMessage(string text);
        [DllImport("user32.dll")] static extern bool DestroyIcon(IntPtr handle);
        [DllImport("dwmapi.dll")] static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);
        [DllImport("user32.dll")] static extern bool ReleaseCapture();
        [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr hwnd, int message, IntPtr wParam, IntPtr lParam);

        public BridgeForm(Options o, EventWaitHandle show, EventWaitHandle exit)
        {
            options = o; showEvent = show; exitEvent = exit; cli = new Cli(AppDomain.CurrentDomain.BaseDirectory, o.DataDir);
            statusReader = new StatusClient(cli.Root, o.DataDir).Read;
            Text = "Codex Dots Bridge"; Name = "CodexDotsBridgeStatus"; ShowInTaskbar = false; StartPosition = FormStartPosition.CenterScreen;
            FormBorderStyle = FormBorderStyle.None; MaximizeBox = false; MinimizeBox = false; AutoScaleMode = AutoScaleMode.None;
            AutoSize = false; Font = new Font("Microsoft YaHei UI", 10F); ClientSize = new Size(420, 480); MinimumSize = new Size(420, 0);
            DoubleBuffered = true; Padding = new Padding(1); BuildLayout(); LoadBrand(); brandView.Image = brand; explorerMessage = RegisterWindowMessage("TaskbarCreated");
            menu.Items.Add("打开状态窗", null, delegate { OpenWindow(); });
            controlItem.Click += async delegate { await ChangeService(); }; menu.Items.Add(controlItem);
            menu.Items.Add("刷新状态", null, async delegate { await RefreshState(); }); menu.Items.Add("复制诊断", null, delegate { CopyDiagnostics(); });
            menu.Items.Add(new ToolStripSeparator()); autoItem.Click += async delegate { await ChangeAutostart(); }; menu.Items.Add(autoItem);
            menu.Items.Add(new ToolStripSeparator()); menu.Items.Add("退出托盘", null, delegate { ExitTray(); });
            menu.Font = new Font("Microsoft YaHei UI", 9.5F); menu.Padding = new Padding(6); foreach (ToolStripItem item in menu.Items) if (!(item is ToolStripSeparator)) item.Padding = new Padding(6, 5, 12, 5);
            tray.ContextMenuStrip = menu; tray.MouseClick += delegate(object sender, MouseEventArgs e) { if (e.Button == MouseButtons.Left) OpenWindow(); };
            poll.Interval = 1000; poll.Tick += async delegate { if ((DateTime.UtcNow - lastCheck).TotalSeconds >= (Visible ? 5 : 15)) await RefreshState(false); };
            SystemEvents.PowerModeChanged += PowerChanged; SystemEvents.UserPreferenceChanged += PreferenceChanged;
            FormClosing += delegate(object sender, FormClosingEventArgs e)
            {
                if (!shuttingDown && (e.CloseReason == CloseReason.UserClosing || e.CloseReason == CloseReason.TaskManagerClosing)) { e.Cancel = true; Hide(); }
                else if (!shuttingDown && e.CloseReason == CloseReason.WindowsShutDown) { Shutdown(); EventHandler handler = Exiting; if (handler != null) handler(this, EventArgs.Empty); }
            };
            Shown += delegate { if (options.Preview && options.Screenshot != null) SavePreview(); };
            ApplyTheme(); Render();
            CapturePresentation(this); CapturePresentation(menu);
            foreach (ToolStripItem item in menu.Items) menuItemPadding.Add(item, item.Padding);
            // Keep immutable 96-DPI geometry and font tokens: neither GDI caches nor rounding
            // from repeated monitor transitions may change the intended DIP proportions.
            using (Graphics graphics = CreateGraphics()) ScalePresentation(graphics.DpiX / 96F);
        }
        void BuildLayout()
        {
            outer.ColumnCount = 1; outer.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100)); outer.AutoSize = true; outer.AutoSizeMode = AutoSizeMode.GrowAndShrink; outer.Dock = DockStyle.Fill; outer.Padding = new Padding(25, 22, 25, 22); outer.Width = 418;
            header.ColumnCount = 3; header.AutoSize = true; header.Dock = DockStyle.Fill; header.Margin = new Padding(0, 0, 0, 25); header.TabIndex = 5;
            header.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 44)); header.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100)); header.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 32));
            brandView.Size = new Size(34, 34); brandView.SizeMode = PictureBoxSizeMode.Zoom; brandView.Margin = new Padding(0); brandView.Anchor = AnchorStyles.Left;
            wordmark.Text = "Codex Dots Bridge"; wordmark.Font = new Font("Segoe UI Semibold", 12F, FontStyle.Bold); wordmark.AutoSize = true; wordmark.Anchor = AnchorStyles.Left; wordmark.Margin = new Padding(0);
            closeButton.Text = "×"; closeButton.Size = new Size(32, 32); closeButton.Font = new Font("Segoe UI", 16F); closeButton.Margin = new Padding(0); closeButton.AccessibleName = "关闭状态窗"; closeButton.TabIndex = 4;
            closeButton.Click += delegate { Hide(); }; header.Controls.Add(brandView, 0, 0); header.Controls.Add(wordmark, 1, 0); header.Controls.Add(closeButton, 2, 0);
            MouseEventHandler drag = delegate(object sender, MouseEventArgs e) { if (e.Button == MouseButtons.Left) { ReleaseCapture(); SendMessage(Handle, 0xA1, new IntPtr(2), IntPtr.Zero); } };
            header.MouseDown += drag; wordmark.MouseDown += drag; brandView.MouseDown += drag; outer.Controls.Add(header);
            TableLayoutPanel statusLine = new TableLayoutPanel(); statusLine.ColumnCount = 2; statusLine.AutoSize = true; statusLine.Dock = DockStyle.Fill; statusLine.Margin = new Padding(0, 0, 0, 8);
            statusLine.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 46)); statusLine.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
            statusBadge.Size = new Size(34, 34); statusBadge.Margin = new Padding(0); statusBadge.Anchor = AnchorStyles.Left;
            heading.AutoSize = true; heading.Font = new Font("Microsoft YaHei UI", 16F, FontStyle.Bold); heading.Margin = new Padding(0); heading.Anchor = AnchorStyles.Left; heading.MaximumSize = new Size(322, 0);
            statusLine.Controls.Add(statusBadge, 0, 0); statusLine.Controls.Add(heading, 1, 0); outer.Controls.Add(statusLine);
            reason.AutoSize = true; reason.MaximumSize = new Size(366, 0); reason.Font = new Font("Microsoft YaHei UI", 9F); reason.Margin = new Padding(0, 0, 0, 12); outer.Controls.Add(reason);
            components.AutoSize = true; components.AutoSizeMode = AutoSizeMode.GrowAndShrink; components.Dock = DockStyle.Fill; components.Padding = new Padding(17, 10, 17, 10); components.Margin = new Padding(0, 15, 0, 20);
            TableLayoutPanel rows = new TableLayoutPanel(); rows.AutoSize = true; rows.ColumnCount = 2; rows.Dock = DockStyle.Top; rows.Margin = new Padding(0);
            rows.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 40)); rows.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 60));
            AddRow(rows, "本机服务", service); AddRow(rows, "云端连接", cloud); AddRow(rows, "Dot 订阅", dot); components.Controls.Add(rows); outer.Controls.Add(components);
            TableLayoutPanel actions = new TableLayoutPanel(); actions.ColumnCount = 2; actions.AutoSize = true; actions.Dock = DockStyle.Fill; actions.Margin = new Padding(0, 0, 0, 22); actions.TabIndex = 0;
            actions.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 50)); actions.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 50));
            control.AutoSize = refresh.AutoSize = false; control.MinimumSize = refresh.MinimumSize = new Size(100, 40); control.Height = refresh.Height = 40; control.Dock = refresh.Dock = DockStyle.Fill;
            control.Margin = new Padding(0, 0, 5, 0); refresh.Margin = new Padding(5, 0, 0, 0); refresh.Text = "刷新状态"; control.TabIndex = 0; refresh.TabIndex = 1;
            control.Click += async delegate { await ChangeService(); }; refresh.Click += async delegate { await RefreshState(); }; actions.Controls.Add(control, 0, 0); actions.Controls.Add(refresh, 1, 0); outer.Controls.Add(actions);
            footer.ColumnCount = 2; footer.RowCount = 3; footer.AutoSize = false; footer.Dock = DockStyle.Top; footer.Padding = new Padding(0, 14, 0, 0); footer.Margin = new Padding(0); footer.TabIndex = 1;
            footer.RowStyles.Add(new RowStyle(SizeType.AutoSize)); footer.RowStyles.Add(new RowStyle(SizeType.AutoSize)); footer.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            footer.Paint += delegate(object sender, PaintEventArgs e) { using (Pen pen = new Pen(components.LineColor)) e.Graphics.DrawLine(pen, 0, 0, footer.Width, 0); };
            footer.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100)); footer.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
            versions.AutoSize = true; versions.Font = new Font("Microsoft YaHei UI", 9F); versions.MaximumSize = new Size(366, 0); versions.Margin = new Padding(0, 0, 0, 5); footer.Controls.Add(versions, 0, 0); footer.SetColumnSpan(versions, 2);
            autostart.AutoSize = true; autostart.Font = new Font("Microsoft YaHei UI", 8.5F); autostart.Margin = new Padding(0, 0, 0, 8); footer.Controls.Add(autostart, 0, 1); footer.SetColumnSpan(autostart, 2);
            checkedAt.AutoSize = true; checkedAt.Font = autostart.Font; checkedAt.Margin = new Padding(0); footer.Controls.Add(checkedAt, 0, 2);
            copy.AutoSize = true; copy.Text = "复制诊断"; copy.Font = autostart.Font; copy.Anchor = AnchorStyles.Right; copy.Margin = new Padding(0); copy.TabIndex = 2; copy.LinkBehavior = LinkBehavior.HoverUnderline; copy.LinkClicked += delegate { CopyDiagnostics(); }; footer.Controls.Add(copy, 1, 2);
            outer.Controls.Add(footer); Controls.Add(outer);
        }
        void AddRow(TableLayoutPanel rows, string title, Label value)
        {
            int row = rows.RowCount++; Label label = new Label(); label.Text = title; label.AutoSize = true; label.Margin = new Padding(0, 8, 0, 8); rows.Controls.Add(label, 0, row);
            value.AutoSize = true; value.Anchor = AnchorStyles.Right; value.TextAlign = ContentAlignment.MiddleRight; value.Font = new Font("Microsoft YaHei UI", 10F, FontStyle.Bold); value.Margin = new Padding(0, 8, 0, 8); value.MaximumSize = new Size(200, 0); rows.Controls.Add(value, 1, row);
        }
        void LoadBrand()
        {
            Assembly a = Assembly.GetExecutingAssembly(); using (Stream stream = a.GetManifestResourceStream("Xingdu.png")) { if (stream != null) using (Image source = Image.FromStream(stream)) brand = new Bitmap(source); }
            if (brand == null) { string asset = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "docs", "素材", "星渡", "星渡-应用-128.png"); if (File.Exists(asset)) using (Image source = Image.FromFile(asset)) brand = new Bitmap(source); }
            if (brand == null) throw new InvalidOperationException("brand_resource_required");
        }
        public void Initialize()
        {
            if (initialized) return; initialized = true;
            if (options.Preview)
            {
                if (options.StateFile != null)
                {
                    // Refresh only the fixture timestamp: screenshots are isolated and cannot be live evidence.
                    Dictionary<string, object> fixture = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(File.ReadAllText(options.StateFile, Encoding.UTF8));
                    fixture["checked_at"] = DateTimeOffset.UtcNow.ToString("o"); state = Snapshot.Parse(new JavaScriptSerializer().Serialize(fixture));
                }
                Text += " · 预览"; control.Enabled = false; autoItem.Enabled = false; Render(); return;
            }
            showWait = ThreadPool.RegisterWaitForSingleObject(showEvent, delegate { Dispatch(OpenWindow); }, null, Timeout.Infinite, false);
            exitWait = ThreadPool.RegisterWaitForSingleObject(exitEvent, delegate { Dispatch(ExitTray); }, null, Timeout.Infinite, false);
            tray.Visible = true; poll.Start(); BeginInvoke(new Action(async delegate { await RefreshState(false); }));
        }
        protected override void OnLoad(EventArgs e) { base.OnLoad(e); Initialize(); }
        protected override void OnHandleCreated(EventArgs e) { base.OnHandleCreated(e); if (options != null) ApplyTheme(); }
        void Dispatch(Action action) { try { if (!shuttingDown && IsHandleCreated) BeginInvoke(action); } catch (InvalidOperationException) { } }
        public void OpenWindow()
        {
            if (shuttingDown) return;
            Show(); if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal; Activate(); BringToFront();
            if (!options.Preview) { if ((DateTime.UtcNow - lastCheck).TotalSeconds > 45) { state = Snapshot.Unknown(state, "stale_status"); Render(); } BeginInvoke(new Action(async delegate { await RefreshState(false); })); }
        }
        protected override bool ProcessCmdKey(ref Message msg, Keys keyData) { if (keyData == Keys.Escape) { Hide(); return true; } return base.ProcessCmdKey(ref msg, keyData); }
        protected override void WndProc(ref Message m)
        {
            if (explorerMessage != 0 && m.Msg == explorerMessage && !shuttingDown && !options.Preview) { tray.Visible = false; tray.Visible = true; }
            if (m.Msg == 0x02E0 && !shuttingDown) { float next = (m.WParam.ToInt64() & 0xffff) / 96F; Dispatch(delegate { ScalePresentation(next); }); }
            base.WndProc(ref m);
        }
        void ScalePresentation(float next)
        {
            if (shuttingDown || next < 0.75F || next > 4F || (presentationFontsInitialized && Math.Abs(next - presentationScale) < 0.01F)) return;
            layoutDirty = true;
            presentationScale = next; List<Font> fonts = new List<Font>(); SuspendLayout();
            try
            {
                foreach (PresentationToken token in presentationTokens)
                {
                    token.ApplyGeometry(next);
                    Font font = new Font(token.Family, token.Points * 96F / 72F * next, token.Style, GraphicsUnit.Pixel);
                    fonts.Add(font); token.Control.Font = font;
                }
                foreach (KeyValuePair<ToolStripItem, Padding> item in menuItemPadding) item.Key.Padding = ScalePadding(item.Value, next);
                menu.ImageScalingSize = new Size(ScaleLength(16, next), ScaleLength(16, next));
                foreach (Font old in currentPresentationFonts) old.Dispose(); currentPresentationFonts = fonts; presentationFontsInitialized = true;
            }
            finally { ResumeLayout(true); }
            Render();
        }
        void CapturePresentation(Control control)
        {
            Font font = control.Font; presentationTokens.Add(new PresentationToken(control));
            bool owned = !font.IsSystemFont;
            foreach (Font existing in originalPresentationFonts) if (Object.ReferenceEquals(existing, font)) owned = false;
            if (owned) originalPresentationFonts.Add(font);
            foreach (Control child in control.Controls) CapturePresentation(child);
        }
        static int ScaleLength(int value, float scale) { return (int)Math.Round(value * scale, MidpointRounding.AwayFromZero); }
        static Size ScaleSize(Size value, float scale) { return new Size(ScaleLength(value.Width, scale), ScaleLength(value.Height, scale)); }
        static Padding ScalePadding(Padding value, float scale) { return new Padding(ScaleLength(value.Left, scale), ScaleLength(value.Top, scale), ScaleLength(value.Right, scale), ScaleLength(value.Bottom, scale)); }
        sealed class PresentationToken
        {
            public readonly Control Control; public readonly string Family; public readonly float Points; public readonly FontStyle Style;
            readonly Padding padding, margin; readonly Size size, minimum, maximum;
            readonly Dictionary<ColumnStyle, float> columns = new Dictionary<ColumnStyle, float>();
            readonly Dictionary<RowStyle, float> rows = new Dictionary<RowStyle, float>();
            public PresentationToken(Control control)
            {
                Control = control; Family = control.Font.FontFamily.Name; Points = control.Font.SizeInPoints; Style = control.Font.Style;
                padding = control.Padding; margin = control.Margin; size = control.Size; minimum = control.MinimumSize; maximum = control.MaximumSize;
                TableLayoutPanel table = control as TableLayoutPanel;
                if (table != null) { foreach (ColumnStyle column in table.ColumnStyles) if (column.SizeType == SizeType.Absolute) columns.Add(column, column.Width); foreach (RowStyle row in table.RowStyles) if (row.SizeType == SizeType.Absolute) rows.Add(row, row.Height); }
            }
            public void ApplyGeometry(float scale)
            {
                Control.Padding = ScalePadding(padding, scale); Control.Margin = ScalePadding(margin, scale);
                Control.MinimumSize = ScaleSize(minimum, scale); Control.MaximumSize = ScaleSize(maximum, scale);
                Form form = Control as Form;
                if (form != null) form.ClientSize = new Size(ScaleLength(420, scale), form.ClientSize.Height);
                else if (!Control.AutoSize) Control.Size = ScaleSize(size, scale);
                foreach (KeyValuePair<ColumnStyle, float> column in columns) column.Key.Width = column.Value * scale;
                foreach (KeyValuePair<RowStyle, float> row in rows) row.Key.Height = row.Value * scale;
            }
        }
        void PowerChanged(object sender, PowerModeChangedEventArgs e)
        {
            if (e.Mode == PowerModes.Resume) Dispatch(delegate { generation++; state = Snapshot.Unknown(state, "resume_recheck"); state.Title = "正在检查"; state.Reason = "系统已恢复，正在重新检查。"; lastCheck = DateTime.MinValue; Render(); BeginInvoke(new Action(async delegate { await RefreshState(); })); });
        }
        void PreferenceChanged(object sender, UserPreferenceChangedEventArgs e) { Dispatch(delegate { ApplyTheme(); Render(); }); }
        Task RefreshState(bool queueIfChecking = true)
        {
            if (shuttingDown) return Task.FromResult(0);
            if (options.Preview) { Render(); return Task.FromResult(0); }
            if (checking)
            {
                // A manual burst adds at most one follow-up. Timer ticks add none.
                if (queueIfChecking && !refreshFollowup && !commandBusy) queuedRefresh = true;
                return refreshTask;
            }
            if (commandBusy) return Task.FromResult(0);
            checking = true; refreshFollowup = queuedRefresh = false;
            refreshTask = ReadState(); return refreshTask;
        }
        async Task ReadState()
        {
            try
            {
                do
                {
                    int checkGeneration = generation; lastCheck = DateTime.UtcNow;
                    CommandResult result = await statusReader();
                    if (shuttingDown) return;
                    if (generation != checkGeneration) queuedRefresh = true;
                    else
                    {
                        if (result.Error != null) state = Snapshot.Unknown(state, result.Error);
                        else
                        {
                            try { state = Snapshot.Parse(result.Output); state.CheckVersions(Program.Version); }
                            catch { state = Snapshot.Unknown(state, "invalid_projection"); }
                        }
                        if (pendingControl == "stop" && state.Control == "start" && (state.State == "stopped" || state.State == "failed")) { pendingControl = null; actionNote = null; }
                        if (pendingControl == "start" && (state.Control == "stop" || state.Tone == "red")) { pendingControl = null; actionNote = null; }
                        if (pendingAutostart != null && state.Autostart == pendingAutostart) { pendingAutostart = null; actionNote = null; }
                    }
                    lastCheck = DateTime.UtcNow; Render();
                    if (!queuedRefresh || refreshFollowup) break;
                    queuedRefresh = false; refreshFollowup = true;
                } while (!shuttingDown);
            }
            finally { checking = queuedRefresh = refreshFollowup = false; refreshTask = null; }
        }
        bool VersionsMatch
        {
            get { return Program.Version != null && state.InstalledVersion == Program.Version && (state.ServiceVersion == null || state.ServiceVersion == Program.Version); }
        }
        async Task ChangeService()
        {
            if (options.Preview || shuttingDown || commandBusy || pendingControl != null || state.Control == "disabled" || !VersionsMatch) return;
            string action = state.Control;
            // Reserve this intent before awaiting; never reverse a click after the state changes.
            commandBusy = true; Render();
            Task activeCheck = refreshTask; if (activeCheck != null) await activeCheck;
            if (shuttingDown) return;
            if (state.Control != action || !VersionsMatch || (DateTime.UtcNow - lastCheck).TotalSeconds > 45)
            { commandBusy = false; actionNote = "状态已更新，请核对后重试。"; Render(); return; }
            if (action == "stop" && (!state.Inflight.HasValue || state.Inflight.Value > 0))
            {
                string fact = state.Inflight.HasValue ? "当前有 " + state.Inflight.Value + " 项在途任务。" : "当前在途任务数量未能确认。";
                if (MessageBox.Show(this, fact + "\r\n停止后台会中断本机连接，云端 Dot 执行可能继续。\r\n确认停止后台？", "Codex Dots Bridge", MessageBoxButtons.OKCancel, MessageBoxIcon.Warning, MessageBoxDefaultButton.Button2) != DialogResult.OK) { commandBusy = false; Render(); return; }
            }
            commandBusy = true; pendingControl = action; actionNote = null; generation++; Render();
            CommandResult result = await cli.Run("run --" + action, 30000, false);
            if (shuttingDown) return;
            commandBusy = false;
            if (result.TimedOut) actionNote = action == "stop" ? "停止尚未确认；请刷新核对，不会强行结束后台。" : "启动尚未确认；请刷新核对。";
            else if (result.Error != null) { pendingControl = null; state = Snapshot.Unknown(state, result.Error); actionNote = action == "stop" ? "停止操作未完成，请刷新核对。" : "启动操作未完成，请刷新核对。"; }
            await RefreshState();
        }
        async Task ChangeAutostart()
        {
            if (options.Preview || shuttingDown || commandBusy || pendingAutostart != null || state.Autostart == "unknown" || !VersionsMatch) return;
            string previous = state.Autostart, target = previous == "enabled" ? "disabled" : "enabled";
            commandBusy = true; Render();
            Task activeCheck = refreshTask; if (activeCheck != null) await activeCheck;
            if (shuttingDown) return;
            if (state.Autostart != previous || !VersionsMatch || (DateTime.UtcNow - lastCheck).TotalSeconds > 45)
            { commandBusy = false; actionNote = "状态已更新，请核对后重试。"; Render(); return; }
            commandBusy = true; pendingAutostart = target; generation++; actionNote = "正在保存登录自启设置；当前后台运行状态保持不变。"; Render();
            CommandResult result = await cli.Run("setup --autostart-state " + target, 30000, false);
            if (shuttingDown) return;
            commandBusy = false; if (result.Error != null && !result.TimedOut) pendingAutostart = null;
            actionNote = result.Error == null ? null : result.TimedOut ? "自启设置尚未确认，请刷新核对。" : "自启设置未完成，请刷新核对。";
            await RefreshState();
            if (result.Error == null && state.Autostart != target) { actionNote = "自启设置未能回读确认，请刷新核对。"; Render(); }
        }
        void CopyDiagnostics()
        {
            try { Clipboard.SetText(state.Diagnostics(Program.Version, EffectiveTitle)); actionNote = "诊断已复制。"; }
            catch (ExternalException) { actionNote = "剪贴板暂不可用，请重试。"; }
            Render();
        }
        string EffectiveTone { get { return pendingControl != null ? "amber" : state.Tone; } }
        string EffectiveTitle { get { if (pendingControl == "stop") return commandBusy ? "正在停止" : "停止尚未确认"; if (pendingControl == "start") return commandBusy ? "正在启动" : "启动尚未确认"; return state.Title; } }
        void Render()
        {
            string title = EffectiveTitle, tone = EffectiveTone;
            bool layoutChanged = layoutDirty || heading.Text != title || reason.Text != (actionNote ?? state.DisplayReason()) || service.Text != state.Service || cloud.Text != state.Cloud || dot.Text != state.Dot;
            heading.Text = title; heading.ForeColor = ForeColor;
            Color statusColor = ToneColor(tone);
            if (statusBadge.Tone != tone || statusBadge.StatusColor != statusColor) { statusBadge.Tone = tone; statusBadge.StatusColor = statusColor; statusBadge.Invalidate(); }
            reason.Text = actionNote ?? state.DisplayReason(); reason.Visible = reason.Text.Length > 0;
            service.Text = state.Service; cloud.Text = state.Cloud; dot.Text = state.Dot;
            string button = state.Control == "start" ? "启动后台" : "停止后台";
            if (pendingControl == "start") button = "正在启动"; else if (pendingControl == "stop") button = "正在停止";
            control.Text = controlItem.Text = button; control.Enabled = controlItem.Enabled = !options.Preview && !commandBusy && pendingControl == null && state.Control != "disabled" && VersionsMatch;
            refresh.Enabled = !commandBusy; autoItem.Enabled = !options.Preview && !commandBusy && pendingAutostart == null && state.Autostart != "unknown" && VersionsMatch;
            autoItem.Text = state.Autostart == "unknown" ? "登录 Windows 后自动启动（未确认）" : "登录 Windows 后自动启动";
            autoItem.CheckState = state.Autostart == "enabled" ? CheckState.Checked : state.Autostart == "unknown" ? CheckState.Indeterminate : CheckState.Unchecked;
            string oldAutostart = autostart.Text, oldVersions = versions.Text;
            autostart.Text = "登录自启：" + (state.Autostart == "enabled" ? "已开启" : state.Autostart == "disabled" ? "未开启" : "未能确认");
            bool same = Program.Version != null && state.InstalledVersion == Program.Version && (state.ServiceVersion == null || state.ServiceVersion == Program.Version);
            versions.Text = same ? "版本 " + Program.Version + (state.ServiceVersion == null ? " · 后台未取得" : "") : "界面 " + (Program.Version ?? "未取得") + "\n安装 " + (state.InstalledVersion ?? "未取得") + " · 后台 " + (state.ServiceVersion ?? "未取得");
            checkedAt.Text = state.CheckedAt.HasValue ? (state.State == "unknown" ? "上次检查 " : "检查于 ") + state.CheckedAt.Value.ToLocalTime().ToString("HH:mm:ss") : "尚未取得检查时间";
            UpdateIcon(tone); string tip = "Codex Dots Bridge · " + title + " · " + (Program.Version ?? "版本未取得"); tray.Text = tip.Length > 63 ? tip.Substring(0, 63) : tip;
            layoutChanged |= oldAutostart != autostart.Text || oldVersions != versions.Text;
            if (!layoutChanged) return;
            versions.MaximumSize = new Size(Math.Max(100, ClientSize.Width - outer.Padding.Horizontal - Padding.Horizontal), 0);
            footer.Height = footer.Padding.Vertical + versions.PreferredSize.Height + versions.Margin.Vertical + autostart.PreferredSize.Height + autostart.Margin.Vertical + Math.Max(checkedAt.PreferredSize.Height, copy.PreferredSize.Height);
            outer.PerformLayout(); int height = outer.GetPreferredSize(new Size(ClientSize.Width - Padding.Horizontal, 0)).Height + Padding.Vertical; if (ClientSize.Height != height) ClientSize = new Size(ClientSize.Width, height);
            layoutDirty = false;
        }
        Color ToneColor(string tone)
        {
            if (SystemInformation.HighContrast) return SystemColors.WindowText;
            if (tone == "green") return dark ? Color.FromArgb(130, 192, 166) : Color.FromArgb(47, 125, 101);
            if (tone == "red") return dark ? Color.FromArgb(219, 141, 148) : Color.FromArgb(188, 89, 98);
            if (tone == "gray") return dark ? Color.FromArgb(165, 183, 192) : Color.FromArgb(114, 131, 140);
            return dark ? Color.FromArgb(225, 183, 120) : Color.FromArgb(183, 122, 50);
        }
        void UpdateIcon(string tone)
        {
            if (currentIcon != null && iconTone == tone) return;
            iconTone = tone;
            using (Bitmap bitmap = new Bitmap(32, 32))
            using (Graphics g = Graphics.FromImage(bitmap))
            {
                g.SmoothingMode = SmoothingMode.AntiAlias; g.InterpolationMode = InterpolationMode.HighQualityBicubic; g.DrawImage(brand, new Rectangle(0, 0, 32, 32));
                using (SolidBrush border = new SolidBrush(SystemInformation.HighContrast ? SystemColors.Window : dark ? Color.FromArgb(36, 39, 44) : Color.White)) g.FillEllipse(border, 19, 19, 13, 13);
                using (SolidBrush fill = new SolidBrush(ToneColor(tone))) g.FillEllipse(fill, 20, 20, 11, 11);
                string mark = tone == "green" ? "✓" : tone == "red" ? "×" : tone == "gray" ? "−" : "!";
                using (Font f = new Font("Segoe UI", 7F, FontStyle.Bold, GraphicsUnit.Point)) using (SolidBrush ink = new SolidBrush(SystemInformation.HighContrast ? SystemColors.Window : dark ? Color.FromArgb(25, 28, 34) : Color.White))
                { StringFormat format = new StringFormat(); format.Alignment = StringAlignment.Center; format.LineAlignment = StringAlignment.Center; g.DrawString(mark, f, ink, new RectangleF(19, 19, 13, 13), format); format.Dispose(); }
                IntPtr handle = bitmap.GetHicon(); Icon next; using (Icon raw = Icon.FromHandle(handle)) next = (Icon)raw.Clone(); DestroyIcon(handle);
                Icon old = currentIcon; currentIcon = next; tray.Icon = next; Icon = next; if (old != null) old.Dispose();
            }
        }
        void ApplyTheme()
        {
            layoutDirty = true;
            iconTone = null;
            dark = options.Theme == "dark";
            if (options.Theme == "auto" && !SystemInformation.HighContrast) try { using (RegistryKey k = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize")) { object v = k == null ? null : k.GetValue("AppsUseLightTheme"); dark = v is int && (int)v == 0; } } catch { }
            Color bg = SystemInformation.HighContrast ? SystemColors.Window : dark ? Color.FromArgb(28, 43, 53) : Color.FromArgb(247, 249, 252);
            Color fg = SystemInformation.HighContrast ? SystemColors.WindowText : dark ? Color.FromArgb(230, 239, 244) : Color.FromArgb(23, 43, 58);
            ThemeControl(this, bg, fg); Color muted = SystemInformation.HighContrast ? fg : dark ? Color.FromArgb(165, 183, 192) : Color.FromArgb(114, 131, 140);
            components.BackColor = SystemInformation.HighContrast ? bg : dark ? Color.FromArgb(34, 54, 64) : Color.FromArgb(240, 244, 247);
            components.LineColor = SystemInformation.HighContrast ? fg : dark ? Color.FromArgb(57, 78, 89) : Color.FromArgb(217, 226, 233);
            foreach (Control row in components.Controls) { ThemeControl(row, components.BackColor, fg); TableLayoutPanel table = row as TableLayoutPanel; if (table != null) foreach (Control cell in table.Controls) if (table.GetColumn(cell) == 0) cell.ForeColor = muted; }
            ((PremiumButton)control).ApplyPalette(dark, true, false); ((PremiumButton)refresh).ApplyPalette(dark, false, false); closeButton.ApplyPalette(dark, false, true);
            reason.ForeColor = versions.ForeColor = autostart.ForeColor = checkedAt.ForeColor = muted; copy.LinkColor = copy.ActiveLinkColor = fg; copy.VisitedLinkColor = fg;
            menu.BackColor = bg; menu.ForeColor = fg; menu.Renderer = SystemInformation.HighContrast ? (ToolStripRenderer)new ToolStripSystemRenderer() : new PremiumMenuRenderer(dark);
            foreach (ToolStripItem item in menu.Items) { item.ForeColor = fg; item.BackColor = bg; }
            if (IsHandleCreated) try { int enabled = dark && !SystemInformation.HighContrast ? 1 : 0; DwmSetWindowAttribute(Handle, 20, ref enabled, 4); int corner = SystemInformation.HighContrast ? 1 : 2; DwmSetWindowAttribute(Handle, 33, ref corner, 4); } catch (DllNotFoundException) { }
            components.Invalidate(); footer.Invalidate(); Invalidate();
        }
        static void ThemeControl(Control c, Color bg, Color fg) { c.BackColor = bg; c.ForeColor = fg; foreach (Control child in c.Controls) ThemeControl(child, bg, fg); }
        void SavePreview()
        {
            System.Windows.Forms.Timer capture = new System.Windows.Forms.Timer(); capture.Interval = 350;
            capture.Tick += delegate { capture.Stop(); capture.Dispose(); try { using (Bitmap bitmap = new Bitmap(Width, Height)) { DrawToBitmap(bitmap, new Rectangle(0, 0, Width, Height)); bitmap.Save(options.Screenshot, System.Drawing.Imaging.ImageFormat.Png); } } finally { Shutdown(); Close(); } }; capture.Start();
        }
        void ExitTray() { if (shuttingDown) return; Shutdown(); EventHandler handler = Exiting; if (handler != null) handler(this, EventArgs.Empty); Close(); }
        public void Shutdown()
        {
            if (shuttingDown) return; shuttingDown = true; poll.Stop(); tray.Visible = false;
            if (showWait != null) showWait.Unregister(null); if (exitWait != null) exitWait.Unregister(null);
            SystemEvents.PowerModeChanged -= PowerChanged; SystemEvents.UserPreferenceChanged -= PreferenceChanged;
        }
        protected override void Dispose(bool disposing)
        {
            if (disposing) { Shutdown(); tray.Dispose(); menu.Dispose(); poll.Dispose(); if (currentIcon != null) currentIcon.Dispose(); if (brand != null) brand.Dispose(); }
            base.Dispose(disposing);
            if (disposing) { foreach (Font font in currentPresentationFonts) font.Dispose(); foreach (Font font in originalPresentationFonts) font.Dispose(); currentPresentationFonts.Clear(); originalPresentationFonts.Clear(); }
        }
        protected override CreateParams CreateParams { get { CreateParams cp = base.CreateParams; cp.ClassStyle |= 0x20000; return cp; } }
        protected override void OnPaint(PaintEventArgs e)
        {
            base.OnPaint(e); e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            Color line = SystemInformation.HighContrast ? SystemColors.WindowText : dark ? Color.FromArgb(66, 87, 98) : Color.FromArgb(207, 219, 228);
            using (GraphicsPath path = Rounded(new RectangleF(0.5F, 0.5F, ClientSize.Width - 1, ClientSize.Height - 1), SystemInformation.HighContrast ? 0 : 11))
            using (Pen pen = new Pen(line)) e.Graphics.DrawPath(pen, path);
        }
        static GraphicsPath Rounded(RectangleF bounds, float radius)
        {
            GraphicsPath p = new GraphicsPath(); if (radius <= 0) { p.AddRectangle(bounds); return p; } float d = radius * 2;
            p.AddArc(bounds.Left, bounds.Top, d, d, 180, 90); p.AddArc(bounds.Right - d, bounds.Top, d, d, 270, 90); p.AddArc(bounds.Right - d, bounds.Bottom - d, d, d, 0, 90); p.AddArc(bounds.Left, bounds.Bottom - d, d, d, 90, 90); p.CloseFigure(); return p;
        }
        sealed class RoundedPanel : Panel
        {
            public Color LineColor = Color.LightGray;
            public RoundedPanel() { DoubleBuffered = true; }
            protected override void OnPaint(PaintEventArgs e)
            {
                base.OnPaint(e); e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
                using (GraphicsPath p = Rounded(new RectangleF(0.5F, 0.5F, Width - 1, Height - 1), SystemInformation.HighContrast ? 0 : 9)) using (Pen pen = new Pen(LineColor)) e.Graphics.DrawPath(pen, p);
            }
        }
        sealed class StatusBadge : Control
        {
            public string Tone = "amber"; public Color StatusColor = Color.DarkGoldenrod;
            public StatusBadge() { SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer, true); TabStop = false; }
            protected override void OnPaint(PaintEventArgs e)
            {
                e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
                RectangleF r = new RectangleF(1, 1, Width - 2, Height - 2);
                using (SolidBrush fill = new SolidBrush(SystemInformation.HighContrast ? SystemColors.Window : Color.FromArgb(22, StatusColor))) e.Graphics.FillEllipse(fill, r);
                using (Pen ring = new Pen(SystemInformation.HighContrast ? SystemColors.WindowText : Color.FromArgb(95, StatusColor), 1)) e.Graphics.DrawEllipse(ring, r);
                string glyph = Tone == "green" ? "✓" : Tone == "red" ? "×" : Tone == "gray" ? "−" : "!";
                using (Font font = new Font("Segoe UI", Math.Max(10, Height * 0.36F), FontStyle.Bold, GraphicsUnit.Pixel))
                { TextRenderer.DrawText(e.Graphics, glyph, font, ClientRectangle, StatusColor, TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPadding); }
            }
        }
        sealed class PremiumButton : Button
        {
            bool hovered, primary, close, darkPalette; Color surface, ink, border;
            public PremiumButton() { SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true); FlatStyle = FlatStyle.Flat; FlatAppearance.BorderSize = 0; Cursor = Cursors.Hand; }
            public void ApplyPalette(bool dark, bool main, bool isClose)
            {
                darkPalette = dark; primary = main; close = isClose;
                surface = SystemInformation.HighContrast ? SystemColors.ButtonFace : main ? dark ? Color.FromArgb(214, 231, 239) : Color.FromArgb(23, 43, 58) : BackColor;
                ink = SystemInformation.HighContrast ? SystemColors.ControlText : main ? dark ? Color.FromArgb(23, 43, 58) : Color.FromArgb(247, 249, 252) : ForeColor;
                border = SystemInformation.HighContrast ? SystemColors.ControlText : dark ? Color.FromArgb(69, 91, 103) : Color.FromArgb(207, 219, 228); Invalidate();
            }
            protected override void OnMouseEnter(EventArgs e) { hovered = true; base.OnMouseEnter(e); Invalidate(); }
            protected override void OnMouseLeave(EventArgs e) { hovered = false; base.OnMouseLeave(e); Invalidate(); }
            protected override void OnGotFocus(EventArgs e) { base.OnGotFocus(e); Invalidate(); }
            protected override void OnLostFocus(EventArgs e) { base.OnLostFocus(e); Invalidate(); }
            protected override void OnEnabledChanged(EventArgs e) { base.OnEnabledChanged(e); Invalidate(); }
            protected override void OnPaint(PaintEventArgs e)
            {
                e.Graphics.Clear(BackColor); e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
                Color fill = surface, text = ink;
                if (!Enabled) { fill = SystemInformation.HighContrast ? SystemColors.ButtonFace : primary ? darkPalette ? Color.FromArgb(61, 81, 92) : Color.FromArgb(220, 229, 235) : surface; text = SystemInformation.HighContrast ? SystemColors.GrayText : darkPalette ? Color.FromArgb(139, 160, 173) : Color.FromArgb(111, 132, 145); }
                else if (hovered) fill = SystemInformation.HighContrast ? SystemColors.Highlight : primary ? darkPalette ? Color.FromArgb(235, 244, 248) : Color.FromArgb(43, 67, 82) : darkPalette ? Color.FromArgb(46, 66, 78) : Color.FromArgb(232, 239, 244);
                if (SystemInformation.HighContrast && hovered && Enabled) text = SystemColors.HighlightText;
                using (GraphicsPath path = Rounded(new RectangleF(0.5F, 0.5F, Width - 1, Height - 1), SystemInformation.HighContrast ? 0 : 7))
                {
                    using (SolidBrush brush = new SolidBrush(fill)) e.Graphics.FillPath(brush, path);
                    if (!close && !primary) using (Pen pen = new Pen(border)) e.Graphics.DrawPath(pen, path);
                }
                TextRenderer.DrawText(e.Graphics, Text, Font, ClientRectangle, text, TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.SingleLine | TextFormatFlags.NoPadding);
                if (Focused && ShowFocusCues) ControlPaint.DrawFocusRectangle(e.Graphics, new Rectangle(5, 5, Width - 10, Height - 10), text, fill);
            }
        }
        sealed class MenuColors : ProfessionalColorTable
        {
            readonly bool dark; public MenuColors(bool value) { dark = value; UseSystemColors = false; }
            public override Color ToolStripDropDownBackground { get { return dark ? Color.FromArgb(28, 43, 53) : Color.FromArgb(247, 249, 252); } }
            public override Color ImageMarginGradientBegin { get { return ToolStripDropDownBackground; } } public override Color ImageMarginGradientMiddle { get { return ToolStripDropDownBackground; } } public override Color ImageMarginGradientEnd { get { return ToolStripDropDownBackground; } }
            public override Color MenuItemSelected { get { return dark ? Color.FromArgb(46, 66, 78) : Color.FromArgb(232, 239, 244); } }
            public override Color MenuItemBorder { get { return MenuItemSelected; } } public override Color MenuBorder { get { return dark ? Color.FromArgb(69, 91, 103) : Color.FromArgb(207, 219, 228); } }
            public override Color SeparatorDark { get { return MenuBorder; } } public override Color SeparatorLight { get { return ToolStripDropDownBackground; } }
        }
        sealed class PremiumMenuRenderer : ToolStripProfessionalRenderer
        {
            readonly bool dark; public PremiumMenuRenderer(bool value) : base(new MenuColors(value)) { dark = value; }
            protected override void OnRenderItemCheck(ToolStripItemImageRenderEventArgs e)
            {
                ToolStripMenuItem item = e.Item as ToolStripMenuItem; if (item == null) return;
                Color ink = dark ? Color.FromArgb(165, 183, 192) : Color.FromArgb(114, 131, 140);
                string glyph = item.CheckState == CheckState.Indeterminate ? "−" : "✓";
                using (Font font = new Font("Segoe UI", Math.Max(8, e.ImageRectangle.Height * 0.85F), FontStyle.Bold, GraphicsUnit.Pixel)) TextRenderer.DrawText(e.Graphics, glyph, font, e.ImageRectangle, ink, TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPadding);
            }
            protected override void OnRenderItemText(ToolStripItemTextRenderEventArgs e)
            {
                if (!e.Item.Enabled) e.TextColor = dark ? Color.FromArgb(139, 160, 173) : Color.FromArgb(114, 131, 140);
                base.OnRenderItemText(e);
            }
        }
    }
}
