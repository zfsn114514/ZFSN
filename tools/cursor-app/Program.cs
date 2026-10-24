using System.Diagnostics;
namespace ZfsnCursor;
internal static class Program
{
    [STAThread]
    static void Main(string[] args)
    {
        if (args.Contains("--restore")) { Environment.ExitCode = CursorScheme.RestoreScheme() ? 0 : 1; return; }
        using var mutex = new Mutex(true, "Local\\ZFSN.Cursor.App", out bool created);
        if (!created) { MessageBox.Show("ZFSN 光标已在运行，请查看系统托盘。", "ZFSN Cursor"); return; }
        Application.SetHighDpiMode(HighDpiMode.PerMonitorV2);
        Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
        using var window = new SettingsWindow(args.Contains("--startup"));
        Application.Run(window);
    }
}

internal sealed class SettingsWindow : Form
{
    readonly TrailOverlay overlay = new();
    readonly CursorScheme scheme = new();
    readonly NotifyIcon tray;
    readonly AppSettings settings = AppSettings.Load();
    readonly MenuButton toggle = new() { Text = "启动光标与拖尾", Width = 220 };
    readonly Label status = new() { AutoSize = false, Height = 56, Dock = DockStyle.Fill, ForeColor = Palette.Cyan };
    readonly CheckBox replace, pause, halo, launch, closeToTray, startup;
    readonly TrackBar intensity;
    readonly Label intensityLabel;
    bool running, exiting, ready;
    public SettingsWindow(bool startupLaunch)
    {
        Text = "ZFSN / CURSOR CONTROL"; ClientSize = new Size(820, 690); MinimumSize = new Size(740, 700);
        StartPosition = FormStartPosition.CenterScreen; BackColor = Palette.Background; ForeColor = Palette.Text;
        Font = new Font("Microsoft YaHei UI", 10); AutoScaleMode = AutoScaleMode.Dpi;
        using (var resource = CursorScheme.Resource(".Assets.app.ico"))
        using (var sourceIcon = new Icon(resource)) Icon = (Icon)sourceIcon.Clone();
        var root = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 3, Padding = new Padding(26) };
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 118)); root.RowStyles.Add(new RowStyle(SizeType.Percent, 100)); root.RowStyles.Add(new RowStyle(SizeType.Absolute, 70));
        var header = new HeaderPanel { Dock = DockStyle.Fill, Padding = new Padding(22, 12, 10, 10) };
        header.Controls.Add(new Label { Text = "光标控制终端 / PERSONAL POINTER SYSTEM", ForeColor = Palette.Cyan, Dock = DockStyle.Bottom, Height = 26, Font = new Font("Consolas", 10) });
        header.Controls.Add(new Label { Text = "ZFSN / CURSOR", ForeColor = Palette.Yellow, Dock = DockStyle.Top, Height = 52, Font = new Font("Segoe UI", 28, FontStyle.Bold | FontStyle.Italic) });
        root.Controls.Add(header, 0, 0);
        var body = new FlowLayoutPanel { Dock = DockStyle.Fill, FlowDirection = FlowDirection.TopDown, WrapContents = false, AutoScroll = true, Padding = new Padding(4, 10, 0, 0) };
        void Heading(string text) => body.Controls.Add(new Label { Text = text, ForeColor = Palette.Red, AutoSize = true, Margin = new Padding(0, 12, 0, 8), Font = new Font("Consolas", 11, FontStyle.Bold) });
        CheckBox Option(string text, bool value) { var box = new CheckBox { Text = text, Checked = value, AutoSize = true, Margin = new Padding(0, 4, 0, 4), ForeColor = Palette.Text, BackColor = Palette.Background }; body.Controls.Add(box); return box; }
        Heading("01 / 视觉效果");
        replace = Option("使用网站同款箭头与链接圆环", settings.ReplaceCursor);
        halo = Option("显示鼠标跟随光晕", settings.ShowHalo);
        pause = Option("全屏应用中暂停特效", settings.PauseFullscreen);
        intensityLabel = new Label { Text = "", AutoSize = true, ForeColor = Palette.Cyan, Margin = new Padding(0, 8, 0, 0) }; body.Controls.Add(intensityLabel);
        intensity = new TrackBar { Minimum = 10, Maximum = 100, Value = settings.Intensity, TickFrequency = 10, Width = 640, Height = 42, BackColor = Palette.Background }; body.Controls.Add(intensity);
        Heading("02 / 启动与窗口");
        bool registered = false;
        try { registered = StartupRegistration.Enabled; } catch { }
        startup = Option("登录 Windows 后自动启动（后台启用光标）", registered);
        launch = Option("手动打开软件时自动启用光标", settings.StartEffects);
        closeToTray = Option("关闭窗口时隐藏到托盘，保持特效运行", settings.CloseToTray);
        var actions = new FlowLayoutPanel { Width = 690, Height = 56, Margin = new Padding(0, 16, 0, 0) };
        var hide = new MenuButton { Text = "隐藏到托盘" }; hide.Click += (_, _) => Hide();
        var quit = new MenuButton { Text = "退出并恢复" }; quit.Click += (_, _) => ExitApp();
        actions.Controls.AddRange(new Control[] { toggle, hide, quit }); body.Controls.Add(actions);
        var helpers = new FlowLayoutPanel { Width = 690, Height = 52 };
        var defaults = new MenuButton { Text = "恢复特效默认值", Width = 200 }; defaults.Click += (_, _) => { replace.Checked = true; halo.Checked = true; pause.Checked = true; intensity.Value = 100; };
        var folder = new MenuButton { Text = "打开设置目录", Width = 180 }; folder.Click += (_, _) => { try { Directory.CreateDirectory(AppSettings.Folder); Process.Start(new ProcessStartInfo(AppSettings.Folder) { UseShellExecute = true }); } catch (Exception e) { Error(e); } };
        helpers.Controls.AddRange(new Control[] { defaults, folder }); body.Controls.Add(helpers);
        body.SizeChanged += (_, _) => { int width = Math.Max(560, body.ClientSize.Width - 28); actions.Width = helpers.Width = width; intensity.Width = Math.Min(640, width); };
        root.Controls.Add(body, 0, 1); root.Controls.Add(status, 0, 2); Controls.Add(root);
        var menu = new ContextMenuStrip { BackColor = Palette.Panel, ForeColor = Palette.Text, ShowImageMargin = false };
        menu.Items.Add("打开控制终端", null, (_, _) => Open()); menu.Items.Add("启动 / 暂停特效", null, (_, _) => Toggle());
        menu.Items.Add("退出并恢复光标", null, (_, _) => ExitApp());
        tray = new NotifyIcon { Icon = Icon, Text = "ZFSN Cursor / 已暂停", ContextMenuStrip = menu, Visible = true };
        tray.DoubleClick += (_, _) => Open(); toggle.Click += (_, _) => Toggle();
        pause.CheckedChanged += (_, _) => Changed(); halo.CheckedChanged += (_, _) => Changed();
        intensity.ValueChanged += (_, _) => Changed(); launch.CheckedChanged += (_, _) => Changed(); closeToTray.CheckedChanged += (_, _) => Changed();
        replace.CheckedChanged += (_, _) => { if (running) { try { if (replace.Checked) scheme.Apply(); else scheme.Restore(); } catch (Exception e) { Stop(); Error(e); } } Changed(); };
        startup.CheckedChanged += (_, _) => { if (!ready) return; try { StartupRegistration.Set(startup.Checked); status.Text = startup.Checked ? "自启动已启用。请保持程序所在位置不变；移动后重新勾选此选项。" : "已关闭 Windows 登录自启动。"; } catch (Exception e) { ready = false; startup.Checked = !startup.Checked; ready = true; Error(e); } };
        overlay.Failed += error => { Stop(); status.Text = "特效已停止：" + error.Message; Open(); };
        ready = true; Changed(false); status.Text = "待机 / READY\n设置自动保存；可在托盘中随时暂停或退出。";
        FormClosing += (_, e) => { if (!exiting && e.CloseReason == CloseReason.UserClosing && closeToTray.Checked) { e.Cancel = true; Hide(); } else Stop(); };
        Shown += (_, _) => { if (startupLaunch || settings.StartEffects) Toggle(); if (startupLaunch && running) Hide(); };
        Resize += (_, _) => { if (WindowState == FormWindowState.Minimized) Hide(); };
    }
    void Changed(bool save = true)
    {
        overlay.ShowHalo = settings.ShowHalo = halo.Checked; overlay.PauseFullscreen = settings.PauseFullscreen = pause.Checked;
        settings.ReplaceCursor = replace.Checked; settings.StartEffects = launch.Checked; settings.CloseToTray = closeToTray.Checked;
        settings.Intensity = intensity.Value; overlay.Intensity = intensity.Value / 100f; intensityLabel.Text = $"拖尾强度 / {intensity.Value}%";
        if (save && ready) try { settings.Save(); } catch (Exception e) { status.Text = "设置保存失败：" + e.Message; }
    }
    void Open() { Show(); WindowState = FormWindowState.Normal; Activate(); }
    void Error(Exception error) => MessageBox.Show(this, error.Message, "ZFSN / 操作未完成", MessageBoxButtons.OK, MessageBoxIcon.Warning);
    void ExitApp() { exiting = true; Close(); }
    void Toggle()
    {
        if (running) { Stop(); return; }
        try { if (replace.Checked) scheme.Apply(); overlay.StartEffects(); running = true; toggle.Text = "暂停并恢复光标"; tray.Text = "ZFSN Cursor / 运行中"; status.Text = "运行中 / ONLINE\n鼠标特效已启用，设置可即时调整。"; }
        catch (Exception error) { Stop(); Error(error); }
    }
    void Stop() { overlay.StopEffects(); bool restored = scheme.Restore(); running = false; toggle.Text = "启动光标与拖尾"; tray.Text = "ZFSN Cursor / 已暂停"; status.Text = restored ? "已暂停 / STANDBY\n原来的系统光标方案已恢复。" : "特效已停止，但光标恢复失败，请运行 restore.bat 重试。"; }
    protected override void Dispose(bool disposing)
    { if (disposing) { overlay.Dispose(); scheme.Dispose(); tray.Visible = false; tray.Dispose(); } base.Dispose(disposing); }
}
