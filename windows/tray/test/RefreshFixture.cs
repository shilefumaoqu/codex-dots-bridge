// Isolated process fixture and reflection harness. No production commands or paths are used.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;

internal static class RefreshFixture
{
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    public static int Main(string[] args)
    {
        string data = args[Array.IndexOf(args, "--data-dir") + 1];
        string configPath = Path.Combine(data, "fixture.json");
        Dictionary<string, object> config = Json.Deserialize<Dictionary<string, object>>(File.ReadAllText(configPath));
        bool status = args[1] == "status";
        string command = status ? "status" : args[1] == "setup" ? "autostart:" + args[3] : args[1] + ":" + args[2];
        File.AppendAllText(Path.Combine(data, "calls.log"), command + "\n");
        Thread.Sleep(Convert.ToInt32(config[status ? "delay" : "commandDelay"]));
        if (!status)
        {
            if (command == "run:--start") { config["control"] = "stop"; config["state"] = "ready"; }
            if (command == "run:--stop") { config["control"] = "start"; config["state"] = "stopped"; }
            if (args[1] == "setup") config["autostart"] = args[3];
            File.WriteAllText(configPath, Json.Serialize(config)); Console.WriteLine("{}"); return 0;
        }
        if (Convert.ToBoolean(config["invalid"])) { Console.WriteLine("{}"); return 0; }
        bool running = (string)config["control"] == "stop";
        Console.WriteLine(Json.Serialize(new {
            schema = 1, installed_version = config["version"], service_version = running ? config["version"] : null,
            state = config["state"], tone = running ? "green" : "gray", title = running ? "连接就绪" : "后台已停止", reason = "",
            service = running ? "运行中" : "已停止", cloud = "未检查", dot = "未检查", control = config["control"], autostart = config["autostart"],
            checked_at = DateTimeOffset.UtcNow.ToString("o"), task_counts = new Dictionary<string, int>(), inflight_count = config["inflight"], error = (string)null
        })); return 0;
    }
}

internal static class RefreshHarness
{
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    static Assembly assembly; static Type formType, optionsType, snapshotType; static object form; static string data, version;
    static int assertions; static string phase; static readonly List<string> checks = new List<string>();
    [DllImport("user32.dll")] static extern bool EnumThreadWindows(uint thread, EnumWindow callback, IntPtr parameter);
    delegate bool EnumWindow(IntPtr window, IntPtr parameter);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr window, System.Text.StringBuilder text, int count);
    [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr window, int message, IntPtr wParam, IntPtr lParam);
    static object Get(string name) { return formType.GetField(name, BindingFlags.NonPublic | BindingFlags.Instance).GetValue(form); }
    static void Set(string name, object value) { formType.GetField(name, BindingFlags.NonPublic | BindingFlags.Instance).SetValue(form, value); }
    static object Call(string name, params object[] args) { return formType.GetMethod(name, BindingFlags.NonPublic | BindingFlags.Instance).Invoke(form, args); }
    static void Assert(bool condition, string note) { assertions++; if (!condition) throw new Exception(note); }
    static string[] Calls() { string p = Path.Combine(data, "calls.log"); return File.Exists(p) ? File.ReadAllLines(p) : new string[0]; }
    static int Count(string command) { int n = 0; foreach (string s in Calls()) if (s == command) n++; return n; }
    static string State(string field) { object s = Get("state"); return (string)snapshotType.GetField(field).GetValue(s); }
    static void PumpUntil(Func<bool> condition, int timeout = 12000)
    {
        Stopwatch watch = Stopwatch.StartNew();
        while (!condition()) { if (watch.ElapsedMilliseconds > timeout) throw new Exception("harness_timeout:" + phase + ":checking=" + Get("checking") + ":read=" + (Get("refreshTask") == null ? "null" : ((Task)Get("refreshTask")).Status.ToString())); Application.DoEvents(); Thread.Sleep(5); }
        Application.DoEvents();
    }
    static void Wait(Task task) { PumpUntil(delegate { return task.IsCompleted; }); task.GetAwaiter().GetResult(); }
    static Task Refresh(bool manual = false) { return (Task)Call("RefreshState", manual); }
    static Dictionary<string, object> Config(string control = "start", int delay = 200, string auto = "disabled", int inflight = 0)
    {
        return new Dictionary<string, object> { {"version", version}, {"control", control}, {"state", control == "start" ? "stopped" : "ready"}, {"autostart", auto}, {"inflight", inflight}, {"delay", delay}, {"commandDelay", 120}, {"invalid", false} };
    }
    static void Write(Dictionary<string, object> config) { File.WriteAllText(Path.Combine(data, "fixture.json"), Json.Serialize(config)); }
    static void AssertLayout(string note)
    {
        Form window = (Form)form; TableLayoutPanel outer = (TableLayoutPanel)Get("outer");
        window.PerformLayout();
        int required = outer.GetPreferredSize(new Size(window.ClientSize.Width - window.Padding.Horizontal, 0)).Height + window.Padding.Vertical;
        File.AppendAllText(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "layout-evidence.ndjson"), Json.Serialize(new { phase = note, client_width = window.ClientSize.Width, client_height = window.ClientSize.Height, preferred_height = required }) + "\n");
        Assert(window.ClientSize.Height >= required, note + ":preferred_height_clipped:" + window.ClientSize.Height + "<" + required);
        foreach (string name in new string[] { "control", "refresh", "footer", "checkedAt", "copy" })
        {
            Control child = (Control)Get(name); Rectangle bounds = child.Bounds;
            for (Control parent = child.Parent; parent != window; parent = parent.Parent) bounds.Offset(parent.Location);
            Assert(bounds.Width > 0 && bounds.Height > 0 && window.ClientRectangle.Contains(bounds), note + ":" + name + "_clipped:" + bounds);
        }
    }
    static void Create(string name, Dictionary<string, object> config, float? initialScale = null)
    {
        phase = "create-" + name;
        data = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "data-" + name); Directory.CreateDirectory(data); Write(config);
        object options = Activator.CreateInstance(optionsType); optionsType.GetField("DataDir").SetValue(options, data);
        form = Activator.CreateInstance(formType, BindingFlags.Public | BindingFlags.Instance, null, new object[] {options, null, null}, null);
        IntPtr handle = ((Form)form).Handle;
        // Do not Initialize: the harness does not create a NotifyIcon, poll timer, or named waits.
        if (initialScale.HasValue) { Call("ScalePresentation", initialScale.Value); AssertLayout("initial_" + initialScale.Value); }
        Wait(Refresh());
        File.WriteAllText(Path.Combine(data, "calls.log"), "");
    }
    static void Close() { ((Form)form).Dispose(); form = null; }
    static int[] Changes()
    {
        int[] n = new int[3]; ((Button)Get("control")).EnabledChanged += delegate { n[0]++; };
        ((Button)Get("refresh")).EnabledChanged += delegate { n[1]++; };
        ((ToolStripMenuItem)Get("autoItem")).EnabledChanged += delegate { n[2]++; }; return n;
    }
    [STAThread]
    public static int Main(string[] args)
    {
        Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
        int result = 1; EventHandler run = null;
        run = delegate { Application.Idle -= run; result = RunTests(); Application.ExitThread(); };
        Application.Idle += run; Application.Run(); return result;
    }
    static int RunTests()
    {
        try
        {
            assembly = Assembly.LoadFrom(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "CodexDotsBridge.Tray.exe"));
            formType = assembly.GetType("CodexDotsBridge.Tray.BridgeForm"); optionsType = assembly.GetType("CodexDotsBridge.Tray.Options"); snapshotType = assembly.GetType("CodexDotsBridge.Tray.Snapshot");
            version = (string)assembly.GetType("CodexDotsBridge.Tray.Program").GetField("Version").GetValue(null);

            foreach (float scale in new float[] { 1F, 1.25F, 1.5F, 2F })
            {
                Create("initial-dpi-" + scale.ToString(System.Globalization.CultureInfo.InvariantCulture), Config(), scale);
                AssertLayout("initial_status_" + scale); Close();
            }
            Create("runtime-dpi", Config());
            foreach (float scale in new float[] { 1.5F, 2F, 1F, 1.25F, 1.5F })
            {
                Call("ScalePresentation", scale); AssertLayout("runtime_" + scale);
                Call("ApplyTheme"); Call("Render"); AssertLayout("theme_" + scale);
            }
            checks.Add("initial 100/125/150/200 percent and runtime DPI/theme changes immediately fit preferred height, buttons and footer without text changes"); Close();

            Create("steady", Config()); int[] changed = Changes();
            for (int cycle = 0; cycle < 3; cycle++)
            {
                Task read = Refresh(); Assert(((Button)Get("control")).Enabled && ((Button)Get("refresh")).Enabled && ((ToolStripMenuItem)Get("autoItem")).Enabled, "poll_disabled_buttons");
                for (int i = 0; i < 20; i++) Refresh(); Wait(read);
            }
            Assert(Count("status") == 3, "automatic_refresh_queued"); Assert(changed[0] == 0 && changed[1] == 0 && changed[2] == 0, "steady_enabled_transitions");
            checks.Add("3 automatic reads: zero EnabledChanged for control, refresh, autostart; overlapping timer requests add no read"); Close();

            Create("manual", Config("start", 300)); changed = Changes(); Task burst = Refresh();
            for (int i = 0; i < 40; i++) Assert(Object.ReferenceEquals(burst, Refresh(true)), "manual_task_not_shared");
            PumpUntil(delegate { return Count("status") == 2; });
            for (int i = 0; i < 40; i++) Refresh(true); Wait(burst);
            Assert(Count("status") == 2 && changed[0] == 0 && changed[1] == 0 && changed[2] == 0, "manual_storm_or_flicker");
            checks.Add("80 manual refreshes during initial/follow-up: exactly 2 reads, zero EnabledChanged"); Close();

            Create("service", Config("start", 300)); changed = Changes(); Task poll = Refresh(); Task start = (Task)Call("ChangeService");
            Assert((bool)Get("commandBusy") && !((Button)Get("control")).Enabled && !((Button)Get("refresh")).Enabled, "command_not_reserved");
            Wait((Task)Call("ChangeService")); Assert(Count("run:--start") == 0, "duplicate_command_before_status");
            Wait(start); Wait(poll); Assert(Count("run:--start") == 1 && Count("run:--stop") == 0 && State("Control") == "stop", "start_during_query_lost");
            Assert(changed[0] == 2 && changed[1] == 2 && changed[2] == 2, "command_busy_transitions");
            checks.Add("start during query waits, executes once, readbacks; each Enabled changes exactly twice"); Close();

            Create("autostart", Config("start", 300)); changed = Changes(); poll = Refresh(); Task auto = (Task)Call("ChangeAutostart");
            Wait((Task)Call("ChangeAutostart")); Wait(auto); Wait(poll);
            Assert(Count("autostart:enabled") == 1 && Count("run:--start") == 0 && State("Autostart") == "enabled", "autostart_during_query_lost");
            Assert(changed[0] == 2 && changed[1] == 2 && changed[2] == 2, "autostart_busy_transitions");
            checks.Add("autostart during query waits, executes once, readbacks; no service command"); Close();

            Create("changed-intent", Config("stop")); Write(Config("start", 300)); poll = Refresh(); Task stop = (Task)Call("ChangeService"); Wait(stop); Wait(poll);
            Assert(Count("run:--start") == 0 && Count("run:--stop") == 0 && State("Control") == "start" && ((string)Get("actionNote")).Contains("重试"), "click_reversed_after_state_change");
            checks.Add("state changes while stop click waits: no inverse start or stop; explicit retry note"); Close();

            Create("cancel-stop", Config("stop")); Write(Config("stop", 250, "disabled", 2)); poll = Refresh();
            bool dialogSeen = false; uint thread = GetCurrentThreadId(); System.Windows.Forms.Timer cancel = new System.Windows.Forms.Timer(); cancel.Interval = 20;
            cancel.Tick += delegate { EnumThreadWindows(thread, delegate(IntPtr window, IntPtr unused) { var cls = new System.Text.StringBuilder(80); GetClassName(window, cls, cls.Capacity); if (cls.ToString() == "#32770") { dialogSeen = true; SendMessage(window, 0x0111, new IntPtr(2), IntPtr.Zero); } return true; }, IntPtr.Zero); };
            phase = "cancel-stop-wait"; cancel.Start(); stop = (Task)Call("ChangeService"); Wait(stop); cancel.Stop(); cancel.Dispose(); phase = "cancel-poll-wait"; Wait(poll);
            Assert(dialogSeen && Count("run:--stop") == 0 && !(bool)Get("commandBusy") && ((Button)Get("control")).Enabled, "fresh_inflight_cancel_failed");
            checks.Add("fresh query raises real WinForms in-flight stop confirmation; Cancel sends no stop and restores controls"); Close();

            Create("generation", Config("start")); Write(Config("stop", 300)); poll = Refresh();
            PumpUntil(delegate { return Count("status") == 1; }); // Receipt has sampled the old fixture before invalidation.
            Set("generation", (int)Get("generation") + 1); Set("state", snapshotType.GetMethod("Unknown").Invoke(null, new object[] { Get("state"), "resume_recheck" }));
            Write(Config("start", 300)); PumpUntil(delegate { Assert(State("Control") != "stop", "old_generation_applied"); return Count("status") == 2; }); Wait(poll);
            Assert(State("Control") == "start" && Count("status") == 2, "generation_followup_failed");
            checks.Add("old-generation ready receipt discarded; one fresh follow-up applied"); Close();

            Create("invalid", Config()); Dictionary<string, object> invalid = Config(); invalid["invalid"] = true; Write(invalid); Wait(Refresh());
            Assert(State("State") == "unknown" && !((Button)Get("control")).Enabled && ((Button)Get("refresh")).Enabled, "invalid_status_not_guarded");
            Write(Config("start", 6000)); Wait(Refresh()); Assert(State("State") == "unknown" && State("Error") == "status_timeout" && !((Button)Get("control")).Enabled, "timeout_not_guarded");
            Write(Config()); Wait(Refresh()); Assert(((Button)Get("control")).Enabled, "recovery_failed");
            checks.Add("invalid projection and real 5.5s child timeout disable service action; recovery restores it"); Close();

            Create("versions", Config()); Dictionary<string, object> mismatch = Config(); mismatch["version"] = "0.0.0-test"; Write(mismatch); Wait(Refresh());
            Assert(!((Button)Get("control")).Enabled && !((ToolStripMenuItem)Get("autoItem")).Enabled && ((Button)Get("refresh")).Enabled, "version_mismatch_not_guarded");
            Wait((Task)Call("ChangeService")); Wait((Task)Call("ChangeAutostart")); Assert(Count("run:--start") == 0 && Count("autostart:enabled") == 0, "mismatched_command_sent");
            checks.Add("version mismatch disables service/autostart and rejects direct duplicate invocation"); Close();

            Create("exit", Config()); poll = Refresh(); formType.GetMethod("Shutdown").Invoke(form, null); Wait(poll);
            Assert(Count("run:--stop") == 0, "tray_exit_stopped_background"); checks.Add("Shutdown during query sends no service stop"); Close();
            Console.WriteLine(Json.Serialize(new { status = "passed", assertions = assertions, checks = checks, production = "not_touched", fixture_root = AppDomain.CurrentDomain.BaseDirectory })); return 0;
        }
        catch (Exception e) { Console.WriteLine(Json.Serialize(new { status = "failed", assertions = assertions, checks = checks, error = e.ToString() })); return 1; }
        finally { if (form != null) Close(); }
    }
}
