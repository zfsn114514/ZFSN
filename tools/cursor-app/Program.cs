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
        using var window = new SettingsWindow();
        Application.Run(window);
    }
}

internal sealed class SettingsWindow : Form
{
    readonly TrailOverlay overlay = new();
    readonly CursorScheme scheme = new();
    readonly NotifyIcon tray;
    readonly Button toggle = new() { Text = "启动光标与拖尾", Width = 210, Height = 40 };
    readonly Label status = new() { Text = "未启动。点击启动后生效，关闭窗口会退出并恢复光标。", AutoSize = false, Width = 470, Height = 46 };
    readonly CheckBox replace = new() { Text = "使用网站同款箭头与链接圆环", Checked = true, AutoSize = true };
    readonly CheckBox pause = new() { Text = "全屏应用中暂停拖尾", Checked = true, AutoSize = true };
    bool running;
    public SettingsWindow()
    {
        Text = "ZFSN Cursor / 网站同款光标"; ClientSize = new Size(540, 445); MinimumSize = new Size(510, 460);
        StartPosition = FormStartPosition.CenterScreen; BackColor = Color.FromArgb(12, 14, 22); ForeColor = Color.FromArgb(232, 232, 240);
        Font = new Font("Microsoft YaHei UI", 9); AutoScaleMode = AutoScaleMode.Dpi;
        using (var resource = CursorScheme.Resource(".Assets.app.ico"))
        using (var sourceIcon = new Icon(resource)) Icon = (Icon)sourceIcon.Clone();
        var panel = new FlowLayoutPanel { Dock = DockStyle.Fill, FlowDirection = FlowDirection.TopDown, WrapContents = false, Padding = new Padding(26), AutoScroll = true };
        panel.Controls.Add(new Label { Text = "ZFSN / CURSOR", Font = new Font(Font.FontFamily, 21, FontStyle.Bold), ForeColor = Color.FromArgb(255, 45, 74), AutoSize = true, Margin = new Padding(0, 0, 0, 12) });
        panel.Controls.Add(new Label { Text = "直接取自网页 SVG · 26 粒子上限 · 60Hz 拖尾", AutoSize = true, Margin = new Padding(0, 0, 0, 18) });
        panel.Controls.Add(replace); panel.Controls.Add(pause);
        var halo = new CheckBox { Text = "网页同款跟随光晕（显示在桌面内容上层）", Checked = true, AutoSize = true };
        halo.CheckedChanged += (_, _) => overlay.ShowHalo = halo.Checked; panel.Controls.Add(halo);
        panel.Controls.Add(new Label { Text = "拖尾强度（100% 对应网页默认值）", AutoSize = true, Margin = new Padding(0, 15, 0, 0) });
        var intensity = new TrackBar { Minimum = 10, Maximum = 100, Value = 100, TickFrequency = 10, Width = 460, Height = 42 };
        intensity.ValueChanged += (_, _) => overlay.Intensity = intensity.Value / 100f;
        panel.Controls.Add(intensity);
        var actions = new FlowLayoutPanel { Width = 470, Height = 52, Margin = new Padding(0, 8, 0, 8) };
        toggle.BackColor = Color.FromArgb(255, 45, 74); toggle.ForeColor = Color.White; toggle.FlatStyle = FlatStyle.Flat; toggle.Cursor = Cursors.Hand;
        var minimize = new Button { Text = "隐藏到托盘", Width = 145, Height = 40, FlatStyle = FlatStyle.Flat, ForeColor = ForeColor, Cursor = Cursors.Hand };
        minimize.Click += (_, _) => Hide(); actions.Controls.Add(toggle); actions.Controls.Add(minimize); panel.Controls.Add(actions); panel.Controls.Add(status); Controls.Add(panel);
        var menu = new ContextMenuStrip(); menu.Items.Add("打开设置", null, (_, _) => { Show(); WindowState = FormWindowState.Normal; Activate(); });
        menu.Items.Add("启动 / 暂停", null, (_, _) => Toggle()); menu.Items.Add("退出并恢复光标", null, (_, _) => Close());
        tray = new NotifyIcon { Icon = Icon, Text = "ZFSN Cursor", ContextMenuStrip = menu, Visible = true };
        tray.DoubleClick += (_, _) => { Show(); WindowState = FormWindowState.Normal; Activate(); };
        toggle.Click += (_, _) => Toggle();
        pause.CheckedChanged += (_, _) => overlay.PauseFullscreen = pause.Checked;
        replace.CheckedChanged += (_, _) => { if (running) { try { if (replace.Checked) scheme.Apply(); else scheme.Restore(); } catch (Exception error) { Stop(); MessageBox.Show(error.Message, "光标切换失败"); } } };
        overlay.Failed += error => { Stop(); status.Text = "拖尾已停止：" + error.Message; };
        FormClosing += (_, _) => Stop();
    }
    void Toggle()
    {
        if (running) { Stop(); return; }
        try { if (replace.Checked) scheme.Apply(); overlay.StartEffects(); running = true; toggle.Text = "暂停并恢复光标"; status.Text = "运行中。可隐藏到托盘；退出会恢复原来的系统光标方案。"; }
        catch (Exception error) { Stop(); MessageBox.Show(error.Message, "无法启动光标"); }
    }
    void Stop() { overlay.StopEffects(); bool restored = scheme.Restore(); running = false; toggle.Text = "启动光标与拖尾"; status.Text = restored ? "已停止，原来的系统光标方案已恢复。" : "拖尾已停止，但光标恢复失败，请运行 restore.bat 重试。"; }
    protected override void Dispose(bool disposing)
    { if (disposing) { overlay.Dispose(); scheme.Dispose(); tray.Visible = false; tray.Dispose(); } base.Dispose(disposing); }
}
