// Synthetic UI/state fixture. No Initialize, NotifyIcon balloon, browser, CLI or business database.
using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;

internal static class SubscriptionHarness
{
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    static readonly string Instance = "11111111-1111-4111-8111-111111111111";
    static Assembly assembly; static Type formType, snapshotType, preferencesType, resultType; static object form, preferences;
    static string data, version, binding, response, responseError;
    static int assertions, notices, opens, reads; static readonly List<string> checks = new List<string>();
    static TaskCompletionSource<bool> receiptGate; static bool receiptHeld;
    static readonly List<object> aclEvidence = new List<object>();
    // Elevated runners may default new file owners to Administrators. Change
    // only this disposable harness process's default owner, then restore it.
    sealed class CurrentUserOwner : IDisposable
    {
        IntPtr token; readonly SecurityIdentifier original;
        [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
        [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr value);
        [DllImport("advapi32.dll", SetLastError=true)] static extern bool OpenProcessToken(IntPtr process,uint access,out IntPtr value);
        [DllImport("advapi32.dll", SetLastError=true)] static extern bool GetTokenInformation(IntPtr value,int kind,IntPtr buffer,int length,out int needed);
        [DllImport("advapi32.dll", SetLastError=true)] static extern bool SetTokenInformation(IntPtr value,int kind,ref IntPtr buffer,int length);
        SecurityIdentifier Read()
        {
            int needed; GetTokenInformation(token,4,IntPtr.Zero,0,out needed); IntPtr buffer=Marshal.AllocHGlobal(needed);
            try { if(!GetTokenInformation(token,4,buffer,needed,out needed)) throw new Win32Exception(Marshal.GetLastWin32Error()); return new SecurityIdentifier(Marshal.ReadIntPtr(buffer)); }
            finally { Marshal.FreeHGlobal(buffer); }
        }
        void SetOwner(SecurityIdentifier sid)
        {
            byte[] bytes=new byte[sid.BinaryLength]; sid.GetBinaryForm(bytes,0); IntPtr pointer=Marshal.AllocHGlobal(bytes.Length);
            try { Marshal.Copy(bytes,0,pointer,bytes.Length); if(!SetTokenInformation(token,4,ref pointer,IntPtr.Size)) throw new Win32Exception(Marshal.GetLastWin32Error()); }
            finally { Marshal.FreeHGlobal(pointer); }
        }
        public CurrentUserOwner()
        {
            if(!OpenProcessToken(GetCurrentProcess(),0x88,out token)) throw new Win32Exception(Marshal.GetLastWin32Error());
            try { original=Read(); SetOwner(WindowsIdentity.GetCurrent().User); }
            catch { CloseHandle(token);token=IntPtr.Zero;throw; }
        }
        public void Dispose()
        {
            try { SetOwner(original); SecurityIdentifier restored=Read(); if(!restored.Equals(original)) throw new Exception("fixture_token_owner_not_restored"); Console.Error.WriteLine(Json.Serialize(new{cleanup="fixture_token_owner",original=original.Value,restored=restored.Value,matched=true})); }
            finally { CloseHandle(token);token=IntPtr.Zero; }
        }
    }
    static void VerifyPrivateAcl(string path,bool directory)
    {
        FileSystemSecurity acl=directory?(FileSystemSecurity)Directory.GetAccessControl(path):File.GetAccessControl(path); SecurityIdentifier user=WindowsIdentity.GetCurrent().User;
        Assert(acl.GetOwner(typeof(SecurityIdentifier)).Equals(user),"fixture_owner_not_current_user:"+path);
        FileSystemRights writes=FileSystemRights.Write|FileSystemRights.Delete|FileSystemRights.ChangePermissions|FileSystemRights.TakeOwnership|FileSystemRights.DeleteSubdirectoriesAndFiles;
        foreach(FileSystemAccessRule rule in acl.GetAccessRules(true,true,typeof(SecurityIdentifier)))
        {
            SecurityIdentifier sid=(SecurityIdentifier)rule.IdentityReference;
            Assert(rule.AccessControlType!=AccessControlType.Allow||(rule.FileSystemRights&writes)==0||sid.Equals(user)||sid.IsWellKnown(WellKnownSidType.LocalSystemSid)||sid.IsWellKnown(WellKnownSidType.BuiltinAdministratorsSid),"fixture_acl_shared_writer:"+path);
        }
        aclEvidence.Add(new{path=path,owner=user.Value,sddl=acl.GetSecurityDescriptorSddlForm(AccessControlSections.Owner|AccessControlSections.Access),private_writers=true});
    }
    static object Get(string name) { return formType.GetField(name, BindingFlags.Instance | BindingFlags.NonPublic).GetValue(form); }
    static void Set(string name, object value) { formType.GetField(name, BindingFlags.Instance | BindingFlags.NonPublic).SetValue(form, value); }
    static object Call(string name, params object[] args) { return formType.GetMethod(name, BindingFlags.Instance | BindingFlags.NonPublic).Invoke(form, args); }
    static object Field(object value, string name) { return value.GetType().GetField(name).GetValue(value); }
    static void Assert(bool condition, string note) { assertions++; if (!condition) throw new Exception(note); }
    static void Wait(Task task)
    {
        DateTime until = DateTime.UtcNow.AddSeconds(8);
        while (!task.IsCompleted) { if (DateTime.UtcNow > until) throw new Exception("fixture_timeout"); Application.DoEvents(); Thread.Sleep(2); }
        task.GetAwaiter().GetResult(); Application.DoEvents();
    }
    static void Notice<T>(T snapshot) { notices++; }
    static async Task<T> Read<T>()
    {
        reads++; string text = response, error = responseError; TaskCompletionSource<bool> gate = receiptGate;
        await Task.Delay(2);
        if (gate != null) { receiptHeld = true; await gate.Task; }
        T value = (T)Activator.CreateInstance(typeof(T)); typeof(T).GetField("Output").SetValue(value, text); typeof(T).GetField("Error").SetValue(value, error); return value;
    }
    static string Projection(string subscriptionState, string id = "synthetic-subscription", int leaseHours = 4)
    {
        bool active = subscriptionState == "valid" || subscriptionState == "expiring";
        return Json.Serialize(new Dictionary<string, object> {
            {"schema",1}, {"instance_id",Instance}, {"data_binding",binding}, {"installed_version",version}, {"service_version",version},
            {"state",active ? "ready" : "disconnected"}, {"tone",active ? "green" : "amber"}, {"title","连接检查"}, {"reason",""},
            {"service","响应正常"}, {"cloud","已连接"}, {"dot","检查中"}, {"control","stop"}, {"autostart","unknown"}, {"checked_at",DateTimeOffset.UtcNow.ToString("o")},
            {"task_counts",new Dictionary<string,int>()}, {"inflight_count",0}, {"error",null},
            {"subscription",new {state=subscriptionState, active_count=active ? (int?)1 : subscriptionState == "unknown" ? (int?)null : 0,
                id=subscriptionState == "missing" || subscriptionState == "unknown" ? null : id,
                expires_at=subscriptionState == "missing" || subscriptionState == "unknown" ? null : DateTimeOffset.UtcNow.AddHours(active ? leaseHours : -1).ToString("o")}}
        });
    }
    static void Refresh(string state, string id = "synthetic-subscription", int leaseHours = 4)
    { response = Projection(state,id,leaseHours); responseError = null; Wait((Task)Call("RefreshState",false)); }
    static bool SaveUrl(string value) { return (bool)preferencesType.GetMethod("SetAutomationUrl").Invoke(preferences,new object[]{value,binding}); }
    static bool Observe(object prefs) { return (bool)preferencesType.GetMethod("Observe").Invoke(prefs,new object[]{Get("state")}); }
    [STAThread]
    public static int Main(string[] args)
    {
        Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
        CurrentUserOwner owner=null;
        try
        {
            owner=new CurrentUserOwner();
            string root = AppDomain.CurrentDomain.BaseDirectory; data=Path.Combine(root,"subscription-data"); Directory.CreateDirectory(data);
            VerifyPrivateAcl(root,true);VerifyPrivateAcl(data,true);
            if(Array.IndexOf(args,"--fail-after-owner")>=0)throw new Exception("synthetic_fixture_failure_after_owner");
            assembly=Assembly.LoadFrom(Path.Combine(root,"CodexDotsBridge.Tray.exe")); formType=assembly.GetType("CodexDotsBridge.Tray.BridgeForm"); snapshotType=assembly.GetType("CodexDotsBridge.Tray.Snapshot");
            preferencesType=assembly.GetType("CodexDotsBridge.Tray.TrayPreferences"); resultType=assembly.GetType("CodexDotsBridge.Tray.CommandResult");
            version=(string)assembly.GetType("CodexDotsBridge.Tray.Program").GetField("Version").GetValue(null);
            binding=(string)assembly.GetType("CodexDotsBridge.Tray.StatusClient").GetMethod("DataBinding").Invoke(null,new object[]{data,Instance});
            Type optionsType=assembly.GetType("CodexDotsBridge.Tray.Options"); object options=Activator.CreateInstance(optionsType); optionsType.GetField("DataDir").SetValue(options,data);
            form=Activator.CreateInstance(formType,BindingFlags.Instance|BindingFlags.Public,null,new object[]{options,null,null},null); preferences=Get("preferences");
            Type readerType=typeof(Func<>).MakeGenericType(typeof(Task<>).MakeGenericType(resultType));
            Set("statusReader",Delegate.CreateDelegate(readerType,typeof(SubscriptionHarness).GetMethod("Read",BindingFlags.Static|BindingFlags.NonPublic).MakeGenericMethod(resultType)));
            Set("subscriptionNotice",Delegate.CreateDelegate(typeof(Action<>).MakeGenericType(snapshotType),typeof(SubscriptionHarness).GetMethod("Notice",BindingFlags.Static|BindingFlags.NonPublic).MakeGenericMethod(snapshotType)));
            Set("openUrl",new Action<string>(delegate(string url){opens++;Assert(url=="https://chatgpt.com/scheduled/automation/synthetic-rule","wrong_open_target");}));
            Set("automationLinkPrompt",new Func<string,string>(delegate(string button){return "https://chatgpt.com/scheduled/automation/synthetic-rule";}));
            IntPtr handle=((Form)form).Handle; // No Initialize: no real icon, polling or service commands.

            Refresh("expiring","synthetic-subscription",1); Assert(notices==0 && (string)CallProperty("EffectiveTone")=="amber","expiring_popup_or_wrong_tone");
            Assert(((Label)Get("dot")).Text.Contains("有效至"),"expiry_not_shown");
            Refresh("valid","synthetic-subscription",8); Assert(notices==0 && (string)CallProperty("EffectiveTone")=="green","automatic_renewal_not_reflected");
            Assert(((Label)Get("identity")).Text.Contains(data)&&((Label)Get("identity")).Text.Contains(Instance),"instance_data_location_missing");
            checks.Add("injected automatic refresh reflects renewed lease; two-hour warning is amber without popup; instance and data location visible");

            Refresh("expired"); Refresh("expired"); Assert(notices==1,"expiry_not_deduplicated");
            Assert(File.Exists(data+".tray.json"),"private_fixture_preferences_not_saved");VerifyPrivateAcl(data+".tray.json",false);
            object restarted=Activator.CreateInstance(preferencesType,new object[]{data}); Assert(!Observe(restarted),"restart_repeated_balloon");
            Refresh("unknown"); Refresh("expired"); Assert(notices==1,"unknown_cleared_expiry_latch");
            Refresh("valid"); Refresh("expired"); Assert(notices==2,"valid_recovery_did_not_reset");
            Refresh("expired","synthetic-other-subscription"); Assert(notices==3,"different_subscription_not_noticed");
            Refresh("missing"); Refresh("missing"); Assert(notices==4,"missing_not_deduplicated");
            checks.Add("one notice per failure episode; persisted dedup survives restart and unknown; valid recovery resets; distinct subscription and missing states handled");

            foreach(string error in new string[]{"status_timeout","data_binding_mismatch","service_identity_unverified","subscription_projection_upgrade_required"})
            { response=Projection("expired"); responseError=error; Wait((Task)Call("RefreshState",false)); Assert((string)Field(Get("state"),"SubscriptionState")=="unknown"&&notices==4,"error_reported_as_expired:"+error); }
            responseError=null; var stale=Json.Deserialize<Dictionary<string,object>>(Projection("expired")); stale["checked_at"]=DateTimeOffset.UtcNow.AddMinutes(-2).ToString("o"); response=Json.Serialize(stale); Wait((Task)Call("RefreshState",false)); Assert(notices==4&&(string)Field(Get("state"),"State")=="unknown","stale_receipt_not_unknown");
            Refresh("valid"); response=Projection("expired"); receiptGate=new TaskCompletionSource<bool>(); receiptHeld=false; Task old=(Task)Call("RefreshState",false);
            DateTime until=DateTime.UtcNow.AddSeconds(5); while(!receiptHeld){Assert(DateTime.UtcNow<until,"gate_not_reached");Application.DoEvents();Thread.Sleep(2);}
            Set("generation",(int)Get("generation")+1); Set("state",snapshotType.GetMethod("Unknown").Invoke(null,new object[]{Get("state"),"resume_recheck"}));
            TaskCompletionSource<bool> release=receiptGate; receiptGate=null; response=Projection("valid"); release.SetResult(true); Wait(old);
            Assert(notices==4&&(string)Field(Get("state"),"SubscriptionState")=="valid","late_generation_receipt_not_discarded");
            checks.Add("timeout, identity/clone mismatch, legacy projection, stale receipt and resume generation never create expiry alerts");

            foreach(string url in new string[]{"http://chatgpt.com/scheduled/automation/a","https://chatgpt.com:443/scheduled/automation/a","https://u@chatgpt.com/scheduled/automation/a","https://chatgpt.com/scheduled/automation/a?x=1","https://chatgpt.com/scheduled/automation/a#x","https://chatgpt.com.evil/scheduled/automation/a","https://chatgpt.com/scheduled/automation/a%2fb","https://chatgpt.com/scheduled/automation/../a","https://chatgpt.com/scheduled/automation/a\\b","https://chatgpt.com/scheduled/automation/a\n"}) Assert(!SaveUrl(url),"unsafe_url_accepted:"+url);
            Assert(SaveUrl("https://chatgpt.com/scheduled/automation/synthetic-rule"),"safe_url_rejected");
            Refresh("expired"); response=Projection("valid"); Wait((Task)Call("CheckAndHandleSubscription")); Assert(opens==0,"old_expiry_opened_without_fresh_check");
            response=Projection("expired"); Task firstHandle=(Task)Call("CheckAndHandleSubscription"); Task duplicateHandle=(Task)Call("CheckAndHandleSubscription"); Wait(firstHandle); Wait(duplicateHandle); Assert(opens==1&&((string)Get("actionNote")).Contains("尚未确认续订"),"explicit_handling_open_not_bounded_or_double_clicked");
            Wait((Task)Call("CheckAndHandleSubscription")); Assert(opens==1,"completed_fast_double_click_reopened_rule");
            responseError="status_timeout"; Wait((Task)Call("CheckAndHandleSubscription")); Assert(opens==1,"unknown_opened_rule");
            Assert(Directory.GetFiles(data).Length==0,"business_data_directory_written");
            Assert(File.Exists(data+".tray.json"),"tray_sidecar_missing");
            checks.Add("explicit handling rechecks fresh; opens only injected exact allowlisted URL; states no renewal proof; no business data/config/CLI writes");
            Console.WriteLine(Json.Serialize(new{status="passed",assertions=assertions,notices=notices,opens=opens,reads=reads,checks=checks,fixture_root=root,acl_evidence=aclEvidence,production="not_touched",notification="injected",browser="injected"}));return 0;
        }
        catch(Exception error){Console.Error.WriteLine(error);return 1;}
        finally {try {if(form!=null)((Form)form).Dispose();} finally {if(owner!=null)owner.Dispose();}}
    }
    static object CallProperty(string name){return formType.GetProperty(name,BindingFlags.NonPublic|BindingFlags.Instance).GetValue(form,null);}
}
