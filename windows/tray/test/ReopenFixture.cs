// Isolated real-EXE lifecycle regression. Every window and control belongs to a child created here.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

internal static class ReopenFixture
{
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    static readonly string Root = AppDomain.CurrentDomain.BaseDirectory;
    static readonly string Data = Path.Combine(Root, "data");
    static readonly List<object> Evidence = new List<object>();
    static int assertions;
    delegate bool WindowCallback(IntPtr window, IntPtr parameter);
    [DllImport("user32.dll")] static extern bool EnumWindows(WindowCallback callback, IntPtr parameter);
    [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, WindowCallback callback, IntPtr parameter);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr window, StringBuilder text, int length);
    [DllImport("user32.dll")] static extern IntPtr SendMessageTimeout(IntPtr window, uint message, IntPtr wParam, IntPtr lParam, uint flags, uint timeout, out IntPtr result);
    static void Assert(bool condition, string reason) { assertions++; if (!condition) throw new Exception(reason); }
    static string Quote(string value) { return "\"" + value.Replace("\"", "\\\"") + "\""; }
    static Process Start(string executable, string args)
    {
        ProcessStartInfo info = new ProcessStartInfo(executable, args);
        info.WorkingDirectory = Root; info.UseShellExecute = false; info.CreateNoWindow = true; info.WindowStyle = ProcessWindowStyle.Hidden;
        return Process.Start(info);
    }
    static Process Tray(string mode) { return Start(Path.Combine(Root, "CodexDotsBridge.Tray.exe"), mode + " --data-dir " + Quote(Data)); }
    static int Command(string mode)
    {
        using (Process p = Tray(mode)) { if (!p.WaitForExit(12000)) { p.Kill(); throw new Exception("isolated_control_timeout:" + mode); } return p.ExitCode; }
    }
    static IntPtr Window(int owner)
    {
        IntPtr found = IntPtr.Zero;
        EnumWindows(delegate(IntPtr window, IntPtr unused)
        {
            uint pid; GetWindowThreadProcessId(window, out pid); StringBuilder title = new StringBuilder(256); GetWindowText(window, title, 256);
            if (pid == owner && title.ToString() == "Codex Dots Bridge") found = window;
            return true;
        }, IntPtr.Zero);
        return found;
    }
    static bool Wait(Func<bool> condition, int milliseconds = 4000)
    {
        Stopwatch clock = Stopwatch.StartNew();
        do { if (condition()) return true; Thread.Sleep(30); } while (clock.ElapsedMilliseconds < milliseconds);
        return condition();
    }
    static bool Visible(Process owner) { IntPtr window = Window(owner.Id); return window != IntPtr.Zero && IsWindowVisible(window); }
    static bool HasStatus(Process owner, string expected)
    {
        bool found = false; IntPtr window = Window(owner.Id); if (window == IntPtr.Zero) return false;
        EnumChildWindows(window, delegate(IntPtr child, IntPtr unused) { StringBuilder text = new StringBuilder(256); GetWindowText(child, text, 256); if (text.ToString() == expected) found = true; return true; }, IntPtr.Zero);
        return found;
    }
    static void Record(string phase, Process owner)
    {
        IntPtr window = Window(owner.Id); Evidence.Add(new { phase = phase, pid = owner.Id, exited = owner.HasExited, window = window.ToInt64(), visible = window != IntPtr.Zero && IsWindowVisible(window) });
    }
    static void Show(Process owner, string phase)
    {
        Assert(Command("--show") == 0, phase + ":show_receipt"); Assert(Wait(delegate { return Visible(owner); }), phase + ":not_visible");
        Assert(!owner.HasExited && Command("--running") == 0, phase + ":owner_lost"); Record(phase, owner);
    }
    static void SendOwned(Process owner, IntPtr window, uint message, IntPtr wParam)
    {
        uint pid; GetWindowThreadProcessId(window, out pid); Assert(pid == owner.Id && !owner.HasExited, "refuse_nonowned_window");
        IntPtr result; Assert(SendMessageTimeout(window, message, wParam, IntPtr.Zero, 2, 2000, out result) != IntPtr.Zero, "isolated_window_message_timeout");
    }
    static void HideAndShow(Process owner, string method)
    {
        IntPtr window = Window(owner.Id);
        if (method == "custom_x")
        {
            IntPtr button = IntPtr.Zero;
            EnumChildWindows(window, delegate(IntPtr child, IntPtr unused) { StringBuilder text = new StringBuilder(32); GetWindowText(child, text, 32); if (text.ToString() == "×") button = child; return true; }, IntPtr.Zero);
            Assert(button != IntPtr.Zero, "custom_x_not_found"); SendOwned(owner, button, 0x00F5, IntPtr.Zero); // BM_CLICK
        }
        else SendOwned(owner, window, method == "raw_wm_close" ? 0x0010U : 0x0112U, method == "raw_wm_close" ? IntPtr.Zero : new IntPtr(0xF060));
        Assert(Wait(delegate { return !Visible(owner); }), method + ":not_hidden"); Record(method, owner);
        Show(owner, "show_after_" + method);
    }
    static void Cleanup(Process owner)
    {
        if (owner == null) return;
        if (!owner.HasExited)
        {
            try { Command("--exit"); } catch { }
            if (!owner.WaitForExit(1000)) { owner.Kill(); owner.WaitForExit(2000); Evidence.Add(new { phase = "forced_cleanup_owned_orphan", pid = owner.Id }); }
        }
        owner.Dispose();
    }
    static void WriteFixture()
    {
        Directory.CreateDirectory(Data); string version = FileVersionInfo.GetVersionInfo(Path.Combine(Root, "CodexDotsBridge.Tray.exe")).ProductVersion;
        File.WriteAllText(Path.Combine(Data, "fixture.json"), Json.Serialize(new { version = version, control = "start", state = "stopped", autostart = "disabled", inflight = 0, delay = 20, commandDelay = 20, invalid = false }));
        File.WriteAllText(Path.Combine(Data, "config.json"), Json.Serialize(new { owner = "codex-dots-bridge", schema_version = 1, instance_id = "11111111-1111-4111-8111-111111111111" }));
        File.WriteAllText(Path.Combine(Data, "supervisor-state.json"), Json.Serialize(new { owner = "fixture-supervisor", pid = Process.GetCurrentProcess().Id, phase = "stopped", cleanup_complete = true }));
    }
    static void CheckAudit(bool baseline)
    {
        string path = Path.Combine(Data, "calls.log"); string[] calls = File.Exists(path) ? File.ReadAllLines(path) : new string[0];
        foreach (string call in calls) Assert(call == "status", "unexpected_cli_side_effect:" + call);
        if (!baseline) Assert(calls.Length == 0, "periodic_query_started_cli");
        Evidence.Add(new { phase = "fake_cli_audit", calls = calls, backend_commands = 0 });
    }
    static int Run(bool baseline)
    {
        Process owner = null; string failure = null; bool reproduced = false;
        try
        {
            WriteFixture(); owner = Tray("--background");
            Assert(Wait(delegate { return Window(owner.Id) != IntPtr.Zero; }), "initial_window_missing");
            // A HWND alone precedes Application.Run. Require posted status work and a responsive pump.
            Assert(Wait(delegate { if (!baseline) return HasStatus(owner, "后台已停止"); string calls = Path.Combine(Data, "calls.log"); return File.Exists(calls) && File.ReadAllText(calls).Contains("status"); }), "background_pump_status_missing");
            SendOwned(owner, Window(owner.Id), 0x0000, IntPtr.Zero); // WM_NULL, after status work was processed.
            Record("background_message_pump_ready", owner);
            Assert(!Visible(owner), "background_showed_after_pump"); Show(owner, "first_show");
            // Test a fresh Form before UserClosing can persist in WinForms' CloseReason field.
            if (baseline)
            {
                SendOwned(owner, Window(owner.Id), 0x0010, IntPtr.Zero);
                Assert(Wait(delegate { return Window(owner.Id) == IntPtr.Zero; }), "baseline_close_did_not_destroy_form");
                Assert(!owner.HasExited, "baseline_owner_exited"); int receipt = Command("--show"); Thread.Sleep(500);
                Assert(receipt == 0 && !Visible(owner) && Window(owner.Id) == IntPtr.Zero, "baseline_orphan_not_reproduced");
                Record("baseline_raw_close_orphan_show_receipt_0", owner); reproduced = true;
            }
            else
            {
                HideAndShow(owner, "raw_wm_close"); HideAndShow(owner, "custom_x"); HideAndShow(owner, "syscommand_close");
                int oldPid = owner.Id; Assert(Command("--exit") == 0 && owner.WaitForExit(4000), "exit_did_not_stop_ui"); owner.Dispose(); owner = null;
                Assert(Command("--running") == 1, "exit_left_mutex_owner"); owner = Tray("--show"); Assert(Wait(delegate { return Visible(owner); }), "fresh_show_failed");
                Assert(owner.Id != oldPid && !owner.HasExited, "fresh_show_not_new_owner"); Record("exit_then_new_show", owner);
                Assert(Command("--exit") == 0 && owner.WaitForExit(4000), "fresh_exit_failed"); owner.Dispose(); owner = null;
                foreach (string mode in new string[] { "background", "esc-close", "dispose", "shutdown" })
                {
                    using (Process host = Start(typeof(ReopenFixture).Assembly.Location, "--host " + mode))
                    {
                        if (!host.WaitForExit(10000)) { host.Kill(); throw new Exception("isolated_host_timeout:" + mode); }
                        Assert(host.ExitCode == 0, "isolated_host_failed:" + mode);
                        Evidence.Add(Json.DeserializeObject(File.ReadAllText(Path.Combine(Root, "host-" + mode + ".json"))));
                    }
                    Assert(Command("--running") == 1, "host_left_mutex_owner:" + mode);
                }
                owner = Tray("--show"); Assert(Wait(delegate { return Visible(owner); }), "show_after_dispose_failed"); Record("show_after_unexpected_dispose_releases_mutex", owner);
            }
        }
        catch (Exception error) { failure = error.ToString(); }
        finally { Cleanup(owner); }
        try { CheckAudit(baseline); } catch (Exception error) { failure = error.ToString(); }
        Console.WriteLine(Json.Serialize(new { status = failure == null ? (baseline ? "baseline_failure_reproduced" : "passed") : "failed", baseline_failure_reproduced = reproduced, assertions = assertions, evidence = Evidence, failure = failure, production = "not_touched", cli = "isolated fake executable" }));
        return failure == null ? 0 : 1;
    }
    static int Host(string mode)
    {
        Type formType = null; Form form = null; ApplicationContext context = null; bool watchdog = false; bool actionRan = false; string failure = null; string closeReason = null;
        Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
        Assembly assembly = Assembly.LoadFrom(Path.Combine(Root, "CodexDotsBridge.Tray.exe"));
        Type program = assembly.GetType("CodexDotsBridge.Tray.Program"), optionsType = assembly.GetType("CodexDotsBridge.Tray.Options"); formType = assembly.GetType("CodexDotsBridge.Tray.BridgeForm");
        string key = "Local\\CodexDotsBridge.Tray." + (string)program.GetMethod("InstanceKey").Invoke(null, new object[] { Data });
        bool created;
        using (Mutex mutex = new Mutex(true, key, out created))
        using (EventWaitHandle show = new EventWaitHandle(false, EventResetMode.AutoReset, key + ".Show"))
        using (EventWaitHandle exit = new EventWaitHandle(false, EventResetMode.AutoReset, key + ".Exit"))
        using (System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer())
        {
            Assert(created, "host_instance_collision"); object options = Activator.CreateInstance(optionsType); optionsType.GetField("DataDir").SetValue(options, Data);
            form = (Form)Activator.CreateInstance(formType, BindingFlags.Instance | BindingFlags.Public, null, new object[] { options, show, exit }, null);
            context = (ApplicationContext)Activator.CreateInstance(assembly.GetType("CodexDotsBridge.Tray.TrayContext"), new object[] { form, mode != "background" });
            form.FormClosing += delegate(object sender, FormClosingEventArgs args) { closeReason = args.CloseReason + ":cancel=" + args.Cancel; };
            timer.Interval = 300; int tick = 0;
            timer.Tick += delegate
            {
                tick++;
                try
                {
                    if (tick == 1)
                    {
                        actionRan = true;
                        if (mode == "background")
                        {
                            Assert(!form.Visible && form.IsHandleCreated && !form.IsDisposed, "background_visible_at_pump_timer");
                            Record("background_hidden_at_message_pump_timer", Process.GetCurrentProcess());
                            formType.GetMethod("ExitTray", BindingFlags.Instance | BindingFlags.NonPublic).Invoke(form, null);
                        }
                        else if (mode == "dispose") form.Dispose();
                        else if (mode == "shutdown")
                        {
                            FormClosingEventArgs args = new FormClosingEventArgs(CloseReason.WindowsShutDown, false);
                            typeof(Form).GetMethod("OnFormClosing", BindingFlags.Instance | BindingFlags.NonPublic).Invoke(form, new object[] { args });
                            Assert(!args.Cancel, "shutdown_cancelled");
                            Assert((bool)formType.GetField("shuttingDown", BindingFlags.Instance | BindingFlags.NonPublic).GetValue(form), "shutdown_not_applied");
                        }
                        else
                        {
                            object[] args = new object[] { Message.Create(form.Handle, 0, IntPtr.Zero, IntPtr.Zero), Keys.Escape };
                            Assert((bool)formType.GetMethod("ProcessCmdKey", BindingFlags.Instance | BindingFlags.NonPublic).Invoke(form, args), "escape_not_handled");
                            Assert(!form.Visible && form.IsHandleCreated && !form.IsDisposed, "escape_destroyed_form");
                            Assert(Command("--show") == 0, "escape_show_receipt");
                            Assert(Wait(delegate { Application.DoEvents(); return form.Visible; }), "show_after_escape_failed");
                            Record("same_host_show_after_escape", Process.GetCurrentProcess());
                            form.Close(); Assert(!form.Visible && form.IsHandleCreated && !form.IsDisposed, "form_close_destroyed_form");
                            Assert(closeReason == "UserClosing:cancel=True", "form_close_wrong_reason");
                            Evidence.Add(new { phase = "form_close_hides", close_reason = closeReason, disposed = form.IsDisposed, handle = form.IsHandleCreated });
                            Assert(Command("--show") == 0, "form_close_show_receipt");
                            Assert(Wait(delegate { Application.DoEvents(); return form.Visible; }), "show_after_form_close_failed");
                            Record("same_host_show_after_form_close", Process.GetCurrentProcess());
                            formType.GetMethod("ExitTray", BindingFlags.Instance | BindingFlags.NonPublic).Invoke(form, null);
                        }
                    }
                    else if (tick >= 4) { watchdog = true; context.ExitThread(); }
                }
                catch (Exception error) { failure = error.ToString(); context.ExitThread(); }
            };
            timer.Start(); Application.Run(context); timer.Stop();
            if (!actionRan || watchdog) failure = "UI loop did not exit after " + mode;
            File.WriteAllText(Path.Combine(Root, "host-" + mode + ".json"), Json.Serialize(new { phase = "host_" + mode, pid = Process.GetCurrentProcess().Id, assertions = assertions, action_ran = actionRan, watchdog = watchdog, disposed = form.IsDisposed, handle = form.IsHandleCreated, close_reason = closeReason, evidence = Evidence, failure = failure }));
            form.Dispose(); context.Dispose(); mutex.ReleaseMutex();
        }
        return failure == null ? 0 : 1;
    }
    [STAThread] public static int Main(string[] args) { if (args.Length == 2 && args[0] == "--host") return Host(args[1]); return Run(args.Length == 1 && args[0] == "--baseline"); }
}
