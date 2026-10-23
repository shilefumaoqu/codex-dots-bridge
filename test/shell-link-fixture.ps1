# Test-only Unicode Shell Link access; never resolve or launch a target.
if(-not ('SetupShortcutFixture' -as [type])) {
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
public static class SetupShortcutFixture {
  [ComImport, Guid("00021401-0000-0000-C000-000000000046")] class ShellLink { }
  [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("000214F9-0000-0000-C000-000000000046")]
  interface IShellLinkW {
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
  public static string[] Read(string path) {
    object value = new ShellLink();
    try {
      ((IPersistFile)value).Load(path, 0);
      IShellLinkW link = (IShellLinkW)value;
      StringBuilder target = new StringBuilder(32768), arguments = new StringBuilder(32768), directory = new StringBuilder(32768);
      link.GetPath(target, target.Capacity, IntPtr.Zero, 4);
      link.GetArguments(arguments, arguments.Capacity); link.GetWorkingDirectory(directory, directory.Capacity);
      return new string[] { target.ToString(), arguments.ToString(), directory.ToString() };
    } finally { Marshal.FinalReleaseComObject(value); }
  }
  public static void Write(string path, string target, string arguments, string directory) {
    object value = new ShellLink();
    try {
      IShellLinkW link = (IShellLinkW)value;
      link.SetPath(target); link.SetArguments(arguments); link.SetWorkingDirectory(directory);
      ((IPersistFile)value).Save(path, true);
    } finally { Marshal.FinalReleaseComObject(value); }
  }
}
'@
}
function Read-TestShellLink([string]$Path) {
  $fields=[SetupShortcutFixture]::Read($Path)
  [pscustomobject]@{TargetPath=$fields[0];Arguments=$fields[1];WorkingDirectory=$fields[2]}
}