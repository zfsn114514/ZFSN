using System.Reflection;
namespace ZfsnCursor;
internal sealed class CursorScheme : IDisposable
{
    bool applied;
    public static Stream Resource(string suffix)
    {
        var assembly = Assembly.GetExecutingAssembly();
        return assembly.GetManifestResourceStream(assembly.GetManifestResourceNames().Single(name => name.EndsWith(suffix, StringComparison.Ordinal)))!;
    }
    public void Apply()
    {
        if (applied) return;
        string folder = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ZFSN-Cursor", "assets-v1");
        Directory.CreateDirectory(folder);
        try
        {
            foreach (var (name, id) in new[] { ("arrow", 32512u), ("point", 32649u) })
            {
                string file = Path.Combine(folder, name + ".cur");
                using (var input = Resource(".Assets." + name + ".cur"))
                using (var output = File.Create(file)) input.CopyTo(output);
                var cursor = Native.LoadCursorFromFile(file);
                if (cursor == IntPtr.Zero) throw new System.ComponentModel.Win32Exception();
                if (!Native.SetSystemCursor(cursor, id)) { Native.DestroyCursor(cursor); throw new System.ComponentModel.Win32Exception(); }
                applied = true; // Windows owns a cursor after SetSystemCursor succeeds.
            }
        }
        catch { Restore(); throw; }
    }
    public static bool RestoreScheme() => Native.SystemParametersInfo(0x0057, 0, IntPtr.Zero, 0);
    public bool Restore() { if (!applied) return true; bool restored = RestoreScheme(); if (restored) applied = false; return restored; }
    public void Dispose() => Restore();
}
