using System.Text.Json;
using Microsoft.Win32;
namespace ZfsnCursor;

internal sealed class AppSettings
{
    public bool ReplaceCursor { get; set; } = true;
    public bool PauseFullscreen { get; set; } = true;
    public bool ShowHalo { get; set; } = true;
    public bool StartEffects { get; set; }
    public bool CloseToTray { get; set; } = true;
    public int Intensity { get; set; } = 100;
    public static string Folder => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ZFSN", "Cursor");
    public static AppSettings Load(string? directory = null)
    {
        try { var result = JsonSerializer.Deserialize<AppSettings>(File.ReadAllText(Path.Combine(directory ?? Folder, "settings.json"))) ?? new(); result.Intensity = Math.Clamp(result.Intensity, 10, 100); return result; }
        catch { return new(); }
    }
    public void Save(string? directory = null)
    {
        Directory.CreateDirectory(directory ?? Folder);
        string file = Path.Combine(directory ?? Folder, "settings.json");
        File.WriteAllText(file + ".tmp", JsonSerializer.Serialize(this, new JsonSerializerOptions { WriteIndented = true }));
        File.Move(file + ".tmp", file, true);
    }
}

[System.Runtime.Versioning.SupportedOSPlatform("windows")]
internal static class StartupRegistration
{
    const string Key = @"Software\Microsoft\Windows\CurrentVersion\Run";
    public static bool Enabled
    {
        get { using var key = Registry.CurrentUser.OpenSubKey(Key); return key?.GetValue("ZFSNCursor") is string; }
    }
    public static void Set(bool enabled)
    {
        using var key = Registry.CurrentUser.CreateSubKey(Key);
        if (enabled)
        {
            string exe = Environment.ProcessPath ?? throw new IOException("无法获取程序路径。");
            if (!exe.EndsWith("ZFSN.Cursor.exe", StringComparison.OrdinalIgnoreCase)) throw new IOException("请使用发布版 ZFSN.Cursor.exe 设置自启动。");
            key.SetValue("ZFSNCursor", "\"" + exe + "\" --startup");
        }
        else key.DeleteValue("ZFSNCursor", false);
    }
}
