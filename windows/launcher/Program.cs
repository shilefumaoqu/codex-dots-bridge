using System;
using System.IO;
using System.Text;
using System.Collections.Generic;
using System.Diagnostics;
using System.Security.Cryptography;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Web.Script.Serialization;
using Microsoft.Win32;

[assembly: AssemblyTitle("Codex Dots Bridge Launcher")]
[assembly: AssemblyProduct("Codex Dots Bridge Launcher")]
[assembly: AssemblyVersion("1.0.0.0")]
[assembly: AssemblyFileVersion("1.0.0.0")]
[assembly: AssemblyInformationalVersion("launcher-1")]
namespace CodexDotsBridge.Launcher
{
    internal static class Program
    {
        [ComImport, Guid("00021401-0000-0000-C000-000000000046")]
        class ShellLink { }
        // Match IShellLinkW's native vtable; WScript.Shell's TargetPath setter
        // rejects Unicode targets outside the process ANSI code page.
        [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("000214F9-0000-0000-C000-000000000046")]
        interface IShellLinkW
        {
            void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder path, int count, IntPtr findData, uint flags);
            void GetIDList(out IntPtr list);
            void SetIDList(IntPtr list);
            void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder text, int count);
            void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string text);
            void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder path, int count);
            void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string path);
            void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder text, int count);
            void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string text);
            void GetHotkey(out ushort hotkey);
            void SetHotkey(ushort hotkey);
            void GetShowCmd(out int command);
            void SetShowCmd(int command);
            void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder path, int count, out int index);
            void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string path, int index);
            void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string path, uint reserved);
            void Resolve(IntPtr window, uint flags);
            void SetPath([MarshalAs(UnmanagedType.LPWStr)] string path);
        }
        static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 1048576 };
        static readonly string Root = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
        static readonly string Self = Path.Combine(Root, "CodexDotsBridge.Launcher.exe");
        static void WriteReceipt(object value)
        {
            // Redirected receipts have a fixed wire encoding, independent of the
            // user's console code page (paths can contain any Unicode character).
            byte[] bytes = new UTF8Encoding(false).GetBytes(Json.Serialize(value) + Environment.NewLine);
            using (Stream output = Console.OpenStandardOutput()) { output.Write(bytes, 0, bytes.Length); output.Flush(); }
        }
        static string Text(IDictionary<string, object> value, string key) { object found; return value.TryGetValue(key, out found) ? found as string : null; }
        static IDictionary<string, object> Object(IDictionary<string, object> value, string key) { object found; return value.TryGetValue(key, out found) ? found as IDictionary<string, object> : null; }
        static void Require(bool condition, string error) { if (!condition) throw new InvalidOperationException(error); }
        static bool Same(string a, string b) { return String.Equals(a, b, StringComparison.OrdinalIgnoreCase); }
        static string Safe(string path)
        {
            Require(!String.IsNullOrEmpty(path) && Path.IsPathRooted(path), "invalid_launcher_path");
            string full = Path.GetFullPath(path).TrimEnd(Path.DirectorySeparatorChar);
            for (string cursor = full; !String.IsNullOrEmpty(cursor); cursor = Path.GetDirectoryName(cursor))
                if (File.Exists(cursor) || Directory.Exists(cursor)) Require((File.GetAttributes(cursor) & FileAttributes.ReparsePoint) == 0, "unsafe_reparse_path");
            return full;
        }
        static IDictionary<string, object> Read(string path) { Safe(path); return Json.Deserialize<Dictionary<string, object>>(File.ReadAllText(path, Encoding.UTF8)); }
        static string VersionRoot(IDictionary<string, object> state, string rootKey, string versionKey)
        {
            string version = Text(state, versionKey);
            Require(version != null && System.Text.RegularExpressions.Regex.IsMatch(version, @"^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$"), "invalid_installer_version");
            string expected = Path.Combine(Root, "payload", version);
            Require(Same(Safe(Text(state, rootKey)), expected), "invalid_payload_root");
            return expected;
        }
        static IDictionary<string, object> Context(bool launch)
        {
            Safe(Root); Safe(Self);
            string statePath = Path.Combine(Root, "installation-state.json"), transactionPath = Path.Combine(Root, ".setup-transaction.json");
            if (launch) Require(!File.Exists(transactionPath), "previous_installation_requires_recovery");
            IDictionary<string, object> state;
            if (File.Exists(statePath))
            {
                state = Read(statePath);
                Require(Text(state, "owner") == "codex-dots-bridge-setup" && Convert.ToInt32(state["schema"]) == 1, "foreign_installer_state");
                Require(Same(Safe(Text(state, "install_directory")), Root), "installer_directory_mismatch");
                VersionRoot(state, "payload_root", "version");
            }
            else
            {
                Require(!launch && File.Exists(transactionPath), "installer_state_missing");
                state = Read(transactionPath);
                Require(Text(state, "owner") == "codex-dots-bridge-setup" && Convert.ToInt32(state["schema"]) == 1, "foreign_installation_transaction");
                Require(Same(Safe(Text(state, "install_directory")), Root), "installer_directory_mismatch");
                VersionRoot(state, "new_root", "version");
            }
            string data = Safe(Text(state, "data_dir"));
            Require(!Same(data, Root) && !data.StartsWith(Root + "\\", StringComparison.OrdinalIgnoreCase) && !Root.StartsWith(data + "\\", StringComparison.OrdinalIgnoreCase), "data_program_path_overlap");
            Safe(Text(state, "app_data"));
            if (launch) Require(Text(state, "launcher_sha256") == Hash(Self), "launcher_binary_changed");
            return state;
        }
        static string Startup(IDictionary<string, object> state)
        {
            string appData = Safe(Text(state, "app_data"));
            Require(Same(appData, Safe(Environment.GetEnvironmentVariable("APPDATA"))), "startup_directory_mismatch");
            return Safe(Path.Combine(appData, "Microsoft", "Windows", "Start Menu", "Programs", "Startup", "CodexDotsBridge.lnk"));
        }
        static string Approval(string name)
        {
            try
            {
                using (RegistryKey key = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\StartupFolder", false))
                {
                    object value = key == null ? null : key.GetValue(name);
                    if (value == null) return "enabled";
                    byte[] bytes = value as byte[];
                    if (bytes == null || bytes.Length < 12) return "unknown";
                    if (bytes[0] == 2 || bytes[0] == 6) return "enabled";
                    if (bytes[0] == 3 || bytes[0] == 7) return "disabled";
                    return "unknown";
                }
            }
            catch { return "unknown"; }
        }
        static void Release(object instance) { if (instance != null && Marshal.IsComObject(instance)) Marshal.FinalReleaseComObject(instance); }
        static bool Owned(string path)
        {
            object shortcut = new ShellLink();
            try
            {
                ((IPersistFile)shortcut).Load(path, 0); // STGM_READ: ownership inspection never saves.
                IShellLinkW link = (IShellLinkW)shortcut;
                StringBuilder target = new StringBuilder(32768), arguments = new StringBuilder(32768), directory = new StringBuilder(32768);
                link.GetPath(target, target.Capacity, IntPtr.Zero, 4); // SLGP_RAWPATH, never Resolve.
                link.GetArguments(arguments, arguments.Capacity); link.GetWorkingDirectory(directory, directory.Capacity);
                return Same(target.ToString(), Self) && arguments.ToString() == "--autostart" && Same(directory.ToString(), Root);
            }
            catch (COMException) { return false; } // Unreadable/malformed links are never owned.
            finally { Release(shortcut); }
        }
        static void CreateStartupShortcut(string path)
        {
            object shortcut = new ShellLink();
            try
            {
                IShellLinkW link = (IShellLinkW)shortcut;
                link.SetPath(Self); link.SetArguments("--autostart"); link.SetWorkingDirectory(Root);
                link.SetDescription("Codex Dots Bridge 登录启动入口");
                ((IPersistFile)shortcut).Save(path, true);
            }
            finally { Release(shortcut); }
        }
        static object Inspect(string path)
        {
            bool exists = File.Exists(path);
            Require(!Directory.Exists(path), "unsafe_autostart_file");
            return new { schema = 1, path = path, exists = exists, owned = exists && Owned(path), content = exists ? Convert.ToBase64String(File.ReadAllBytes(path)) : null, windows = Approval("CodexDotsBridge.lnk"), legacy_windows = Approval("CodexDotsBridge.vbs") };
        }
        static object StartupCommand(string action, string expected)
        {
            IDictionary<string, object> state = Context(false); string path = Startup(state);
            Require(!Directory.Exists(path), "unsafe_autostart_file");
            if (action == "inspect") return Inspect(path);
            if (action == "acknowledge")
            {
                string receipt = Path.Combine(Root, ".startup-intent.json");
                if (File.Exists(receipt))
                {
                    IDictionary<string, object> intent = Read(receipt);
                    Require(Text(intent, "owner") == "codex-dots-bridge-startup-intent" && Text(intent, "content") == expected && Same(Text(intent, "path"), path), "startup_intent_changed");
                    File.Delete(receipt);
                }
                return Inspect(path);
            }
            Require(action == "enable" || action == "disable", "invalid_startup_action");
            if (File.Exists(path))
            {
                Require(Owned(path), "foreign_autostart_collision");
                if (expected != null) Require(Convert.ToBase64String(File.ReadAllBytes(path)) == expected, "autostart_settings_changed");
                if (action == "disable") { Require(expected != null, "autostart_ownership_required"); File.Delete(path); }
                // A matching link is never saved again, including when Windows disabled it.
                return Inspect(path);
            }
            if (action == "disable") return Inspect(path);
            Require(Approval("CodexDotsBridge.lnk") == "enabled" && Approval("CodexDotsBridge.vbs") == "enabled", "autostart_disabled_or_unconfirmed_by_windows");
            Directory.CreateDirectory(Path.GetDirectoryName(path)); Safe(path);
            string temporary = Path.Combine(Root, ".startup-" + Guid.NewGuid().ToString("N") + ".lnk");
            string intentPath = Path.Combine(Root, ".startup-intent.json"), intentText = null;
            bool intentCreated = false;
            try
            {
                CreateStartupShortcut(temporary);
                Require(Owned(temporary), "autostart_readback_failed");
                Safe(intentPath);
                intentText = Json.Serialize(new { schema = 1, owner = "codex-dots-bridge-startup-intent", path = path, content = Convert.ToBase64String(File.ReadAllBytes(temporary)) });
                using (FileStream intent = new FileStream(intentPath, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                {
                    intentCreated = true;
                    byte[] bytes = Encoding.UTF8.GetBytes(intentText);
                    intent.Write(bytes, 0, bytes.Length); intent.Flush(true);
                }
                File.Move(temporary, path); // Exclusive: never replace a link created concurrently.
                return Inspect(path);
            }
            finally
            {
                if (File.Exists(temporary)) File.Delete(temporary);
                // A rejected move never activated the entry. Remove only our exact unused intent.
                if (intentCreated && !File.Exists(path) && File.Exists(intentPath) && File.ReadAllText(intentPath, Encoding.UTF8) == intentText) File.Delete(intentPath);
            }
        }
        static string Hash(string path) { using (SHA256 hash = SHA256.Create()) using (FileStream file = File.OpenRead(path)) return BitConverter.ToString(hash.ComputeHash(file)).Replace("-", "").ToLowerInvariant(); }
        static void CheckFile(string root, IDictionary<string, object> manifest, string relative)
        {
            string path = Safe(Path.Combine(root, relative.Replace('/', Path.DirectorySeparatorChar))); Require(File.Exists(path), "launcher_payload_missing");
            object entries; Require(manifest.TryGetValue("files", out entries), "invalid_release_manifest");
            string expected = null;
            foreach (object item in (System.Collections.IEnumerable)entries)
            {
                IDictionary<string, object> entry = item as IDictionary<string, object>;
                if (entry != null && Text(entry, "path") == relative) { Require(expected == null, "invalid_release_manifest"); expected = Text(entry, "sha256"); }
            }
            Require(expected != null && Hash(path) == expected, "launcher_payload_changed");
        }
        static string Quote(string value)
        {
            StringBuilder text = new StringBuilder("\""); int slashes = 0;
            foreach (char c in value) { if (c == '\\') { slashes++; continue; } if (c == '"') { text.Append('\\', slashes * 2 + 1); text.Append(c); } else { text.Append('\\', slashes); text.Append(c); } slashes = 0; }
            text.Append('\\', slashes * 2); text.Append('"'); return text.ToString();
        }
        static void Launch()
        {
            IDictionary<string, object> state = Context(true); string root = VersionRoot(state, "payload_root", "version"), data = Text(state, "data_dir");
            IDictionary<string, object> config = Read(Path.Combine(data, "config.json")), binding = Object(config, "installation");
            Require(Text(config, "owner") == "codex-dots-bridge" && binding != null && Same(Safe(Text(binding, "root")), root), "installation_binding_mismatch");
            string nodeRelative = "runtime/node-v24.21.0-win-x64/node.exe", node = Path.Combine(root, nodeRelative.Replace('/', Path.DirectorySeparatorChar));
            Require(Same(Safe(Text(binding, "node_path")), node), "installation_binding_mismatch");
            IDictionary<string, object> registration = Read(Path.Combine(data, "installation.json")), mcp = Object(registration, "mcp");
            Require(Text(registration, "owner") == "codex-dots-bridge" && Text(registration, "instance_id") == Text(config, "instance_id") && Same(Text(registration, "codex_home"), Text(state, "codex_home")) && mcp != null && Text(mcp, "name") == "codex-dots-bridge" && Same(Text(mcp, "command"), node), "launcher_registration_identity_mismatch");
            object mcpArgs; Require(mcp.TryGetValue("args", out mcpArgs), "launcher_registration_identity_mismatch");
            List<string> arguments = new List<string>(); foreach (object argument in (System.Collections.IEnumerable)mcpArgs) arguments.Add(argument as string);
            Require(arguments.Count == 4 && Same(arguments[0], Path.Combine(root, "dist", "main.js")) && arguments[1] == "stdio" && arguments[2] == "--data-dir" && Same(arguments[3], data), "launcher_registration_identity_mismatch");
            IDictionary<string, object> package = Read(Path.Combine(root, "package.json")), manifest = Read(Path.Combine(root, "release-manifest.json"));
            Require(Text(package, "name") == "codex-dots-bridge" && Text(package, "version") == Text(state, "version") && Text(manifest, "version") == Text(state, "version"), "launcher_payload_identity_mismatch");
            Require(Hash(Path.Combine(root, "release-manifest.json")) == Text(state, "package_fingerprint"), "launcher_payload_changed");
            CheckFile(root, manifest, nodeRelative); CheckFile(root, manifest, "dist/main.js"); CheckFile(root, manifest, "CodexDotsBridge.Tray.exe");
            ProcessStartInfo backend = new ProcessStartInfo(node, Quote(Path.Combine(root, "dist", "main.js")) + " run --autostart --data-dir " + Quote(data));
            backend.UseShellExecute = false; backend.CreateNoWindow = true; backend.WorkingDirectory = root; backend.WindowStyle = ProcessWindowStyle.Hidden;
            using (Process process = Process.Start(backend)) { Require(process != null, "launcher_backend_unconfirmed"); }
            ProcessStartInfo tray = new ProcessStartInfo(Path.Combine(root, "CodexDotsBridge.Tray.exe"), "--background --data-dir " + Quote(data));
            tray.UseShellExecute = false; tray.CreateNoWindow = true; tray.WorkingDirectory = root; tray.WindowStyle = ProcessWindowStyle.Hidden;
            using (Process process = Process.Start(tray)) { Require(process != null, "launcher_tray_unconfirmed"); }
        }
        static void Diagnostic(string code, string outcome)
        {
            string temporary = null;
            try
            {
                Safe(Root); string path = Safe(Path.Combine(Root, ".launcher-diagnostics.json"));
                string previous = null;
                if (File.Exists(path))
                {
                    Require(new FileInfo(path).Length <= 65536, "foreign_launcher_diagnostic");
                    previous = File.ReadAllText(path, Encoding.UTF8);
                    IDictionary<string, object> record = Json.Deserialize<Dictionary<string, object>>(previous);
                    Require(Text(record, "owner") == "codex-dots-bridge-launcher" && Convert.ToInt32(record["schema"]) == 1, "foreign_launcher_diagnostic");
                }
                temporary = Path.Combine(Root, ".launcher-diagnostics-" + Guid.NewGuid().ToString("N") + ".tmp");
                using (FileStream stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                {
                    byte[] bytes = Encoding.UTF8.GetBytes(Json.Serialize(new { schema = 1, owner = "codex-dots-bridge-launcher", protocol = 1, at = DateTime.UtcNow.ToString("yyyy-MM-ddTHH:mm:ss.fffZ"), code = code, outcome = outcome }));
                    stream.Write(bytes, 0, bytes.Length);
                }
                if (previous == null) File.Move(temporary, path);
                else { Require(File.ReadAllText(path, Encoding.UTF8) == previous, "launcher_diagnostic_changed"); File.Replace(temporary, path, null); }
            }
            catch { }
            finally { if (temporary != null) try { if (File.Exists(temporary)) File.Delete(temporary); } catch { } }
        }
        [STAThread]
        static int Main(string[] args)
        {
            try
            {
                if (args.Length == 1 && args[0] == "--version") { WriteReceipt(new { protocol = 1, version = "launcher-1" }); return 0; }
                if (args.Length == 1 && args[0] == "--autostart") { Launch(); Diagnostic("launcher_dispatched_requires_runtime_readback", "dispatched"); return 0; }
                Require((args.Length == 2 || args.Length == 4) && args[0] == "--startup" && (args.Length != 4 || args[2] == "--expected"), "invalid_launcher_arguments");
                WriteReceipt(StartupCommand(args[1], args.Length == 4 ? args[3] : null)); return 0;
            }
            catch (Exception error)
            {
                string code = error.Message;
                if (!System.Text.RegularExpressions.Regex.IsMatch(code, "^[a-z][a-z0-9_]*$")) code = "launcher_operation_failed";
                if (args.Length == 1 && args[0] == "--autostart") Diagnostic(code, "failed");
                WriteReceipt(new { error = code }); return 1;
            }
        }
    }
}
