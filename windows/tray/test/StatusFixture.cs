// Real loopback transport fixture. No bridge, Node, credentials or production
// installation are used; the client is loaded from the candidate tray assembly.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Reflection;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

internal static class StatusHarness
{
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    static readonly string Instance = "11111111-1111-4111-8111-111111111111";
    static string root, data, version; static Type clientType; static object client; static int assertions, requests;
    static void Assert(bool condition, string note) { Interlocked.Increment(ref assertions); if (!condition) throw new Exception(note); }
    static void Write(string name, object value) { File.WriteAllText(Path.Combine(data, name), Json.Serialize(value), new UTF8Encoding(false)); }
    static Dictionary<string, object> Config(int port)
    {
        return new Dictionary<string, object> { { "owner", "codex-dots-bridge" }, { "schema_version", 1 }, { "instance_id", Instance }, { "endpoint", "http://127.0.0.1:" + port + "/" } };
    }
    static Dictionary<string, object> Projection()
    {
        return new Dictionary<string, object> {
            { "schema", 1 }, { "instance_id", Instance }, { "installed_version", version }, { "service_version", version }, { "state", "ready" },
            { "tone", "green" }, { "title", "连接就绪" }, { "reason", "连接检查" }, { "service", "响应正常" }, { "cloud", "已连接" }, { "dot", "订阅有效" },
            { "control", "stop" }, { "autostart", "unknown" }, { "checked_at", DateTimeOffset.UtcNow.ToString("o") },
            { "task_counts", new Dictionary<string, int>() }, { "inflight_count", 0 }, { "error", null }
        };
    }
    static object Read()
    {
        Task task = (Task)clientType.GetMethod("Read").Invoke(client, null);
        Assert(task.Wait(6000), "client_deadline_missing");
        return task.GetType().GetProperty("Result").GetValue(task, null);
    }
    static string Error(object result) { return (string)result.GetType().GetField("Error").GetValue(result); }
    static Dictionary<string, object> Output(object result) { return Json.Deserialize<Dictionary<string, object>>((string)result.GetType().GetField("Output").GetValue(result)); }
    static object Exchange(Func<string> response, int status = 200, int delay = 0)
    {
        TcpListener listener = new TcpListener(IPAddress.Loopback, 0); listener.Start();
        Write("config.json", Config(((IPEndPoint)listener.LocalEndpoint).Port));
        Task server = Task.Run(delegate
        {
            using (TcpClient socket = listener.AcceptTcpClient())
            using (NetworkStream stream = socket.GetStream())
            {
                stream.ReadTimeout = 4000; stream.WriteTimeout = 4000;
                StringBuilder header = new StringBuilder();
                while (!header.ToString().EndsWith("\r\n\r\n", StringComparison.Ordinal))
                {
                    int next = stream.ReadByte(); if (next < 0 || header.Length > 8192) throw new Exception("invalid_http_request"); header.Append((char)next);
                }
                string received = header.ToString(); requests++;
                Assert(received.StartsWith("POST /control/tray_status HTTP/1.1\r\n", StringComparison.Ordinal), "wrong_control_path");
                Assert(received.IndexOf("Authorization: Bearer " + new string('a', 64), StringComparison.OrdinalIgnoreCase) >= 0, "caller_auth_missing");
                Assert(stream.ReadByte() == 123 && stream.ReadByte() == 125, "status_body_not_empty");
                string text = response(); if (delay > 0) Thread.Sleep(delay);
                byte[] body = Encoding.UTF8.GetBytes(text);
                byte[] prefix = Encoding.ASCII.GetBytes("HTTP/1.1 " + status + " Fixture\r\nContent-Type: application/json\r\nContent-Length: " + body.Length + "\r\nConnection: close\r\n" + (status == 302 ? "Location: http://127.0.0.1:1/\r\n" : "") + "\r\n");
                try { stream.Write(prefix, 0, prefix.Length); stream.Write(body, 0, body.Length); } catch (IOException) { if (delay == 0) throw; }
            }
        });
        try { object result = Read(); Assert(server.Wait(6000), "server_fixture_timeout"); return result; }
        finally { listener.Stop(); }
    }
    public static int Main()
    {
        try
        {
            root = AppDomain.CurrentDomain.BaseDirectory; data = Path.Combine(root, "http-fixture"); Directory.CreateDirectory(data);
            Assembly assembly = Assembly.LoadFrom(Path.Combine(root, "CodexDotsBridge.Tray.exe"));
            clientType = assembly.GetType("CodexDotsBridge.Tray.StatusClient");
            version = (string)assembly.GetType("CodexDotsBridge.Tray.Program").GetField("Version").GetValue(null);
            client = Activator.CreateInstance(clientType, BindingFlags.Public | BindingFlags.Instance, null, new object[] { root, data }, null);
            int pid = Process.GetCurrentProcess().Id;
            Write("supervisor-state.json", new { owner = "fixture-supervisor", pid = pid, phase = "running" });
            Write("supervisor.lock", new { owner = "fixture-supervisor", pid = pid });
            Write("service.lock", new { owner = "fixture-service", pid = pid });
            File.WriteAllText(Path.Combine(data, "caller.key"), new string('a', 64));
            // No Node runtime is installed in this harness directory. Success is
            // real authenticated HTTP, not a CLI status fixture or fallback.
            Assert(!File.Exists(Path.Combine(root, "runtime", "node-v24.21.0-win-x64", "node.exe")), "unexpected_runtime_fixture");
            for (int i = 0; i < 3; i++)
            {
                object result = Exchange(delegate { return Json.Serialize(Projection()); });
                Assert(Error(result) == null && (string)Output(result)["state"] == "ready", "authenticated_projection_failed");
            }
            Assert(requests == 3, "polling_did_not_send_once");
            foreach (string waiting in new string[] { "event_delivery_failed", "route_unavailable", "queued_behind_task", "deadline_elapsed", "execution_unverified" })
            {
                object result = Exchange(delegate { var value = Projection(); value["waiting_reason"] = waiting; return Json.Serialize(value); });
                Assert(Error(result) == null && (string)Output(result)["waiting_reason"] == waiting, "task_waiting_reason_lost");
            }
            Assert(Error(Exchange(delegate { var value = Projection(); value["instance_id"] = Guid.NewGuid().ToString(); return Json.Serialize(value); })) == "service_identity_unverified", "foreign_instance_accepted");
            Assert(Error(Exchange(delegate { var value = Projection(); value["checked_at"] = DateTimeOffset.UtcNow.AddMinutes(-2).ToString("o"); return Json.Serialize(value); })) != null, "stale_projection_accepted");
            Assert(Error(Exchange(delegate { return new string(' ', 131073); })) != null, "unbounded_projection_accepted");
            Assert(Error(Exchange(delegate { return Json.Serialize(Projection()); }, 302)) != null, "redirect_accepted");
            Assert(Error(Exchange(delegate { Write("service.lock", new { owner = "replacement", pid = pid }); return Json.Serialize(Projection()); })) == "local_identity_changed", "changed_owner_accepted");
            Write("service.lock", new { owner = "fixture-service", pid = pid });
            Stopwatch budget = Stopwatch.StartNew(); object timeout = Exchange(delegate { return Json.Serialize(Projection()); }, 200, 3200);
            Assert(budget.ElapsedMilliseconds < 5500 && (string)Output(timeout)["state"] == "unknown", "timeout_not_bounded_or_not_unknown");
            var config = Config(1); config["endpoint"] = "http://localhost:1/"; Write("config.json", config);
            Assert(Error(Read()) != null, "nonliteral_loopback_accepted");
            Write("config.json", Config(1)); File.Delete(Path.Combine(data, "supervisor.lock")); File.Delete(Path.Combine(data, "service.lock"));
            Write("supervisor-state.json", new { owner = "fixture-supervisor", pid = pid, phase = "stopped", cleanup_complete = true });
            object offline = Read(); Assert(Error(offline) == null && (string)Output(offline)["state"] == "stopped" && (string)Output(offline)["control"] == "start", "confirmed_stop_cannot_start");
            Console.WriteLine(Json.Serialize(new { status = "passed", assertions = assertions, requests = requests, transport = "authenticated_loopback_http", node_runtime_present = false, production = "not_touched" })); return 0;
        }
        catch (Exception error) { Console.Error.WriteLine(error.ToString()); return 1; }
    }
}
