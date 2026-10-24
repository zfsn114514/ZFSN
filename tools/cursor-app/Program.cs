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
    readonly PreviewPanel preview = new();
    readonly CursorScheme scheme = new();
    readonly NotifyIcon tray;
    readonly AppSettings settings = AppSettings.Load();
    readonly MenuButton toggle = new() { Text = "启动光标与拖尾", Width = 220 };
    readonly Label status = new() { AutoSize = false, Height = 56, Dock = DockStyle.Fill, ForeColor = Palette.Cyan };
    readonly OptionToggle replace, pause, halo, launch, closeToTray, startup;
    readonly IntensitySlider intensity;
    readonly Label intensityLabel;
    bool running, exiting, ready;
    public SettingsWindow(bool startupLaunch)
    {
        Text = "ZFSN / CURSOR CONTROL"; ClientSize = new Size(1080, 740); MinimumSize = new Size(1000, 700);
        StartPosition = FormStartPosition.CenterScreen; BackColor = Palette.Background; ForeColor = Palette.Text;
        Font = new Font("Microsoft YaHei UI", 10); AutoScaleMode = AutoScaleMode.Dpi;
        using (var resource = CursorScheme.Resource(".Assets.app.ico"))
        using (var sourceIcon = new Icon(resource)) Icon = (Icon)sourceIcon.Clone();
        FormBorderStyle = FormBorderStyle.None;
        var root = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 3, Padding = new Padding(1), BackColor=Palette.Background };
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 48)); root.RowStyles.Add(new RowStyle(SizeType.Percent, 100)); root.RowStyles.Add(new RowStyle(SizeType.Absolute, 100));
        var chrome=new Panel { Dock=DockStyle.Fill, BackColor=Palette.Background, Padding=new Padding(24,0,12,0) };
        var caption=new Label { Text="ZFSN  /  CURSOR STUDIO", ForeColor=Palette.Muted, Font=new Font("Consolas",9), Dock=DockStyle.Fill, TextAlign=ContentAlignment.MiddleLeft };
        var close=new MenuButton { Name="CloseWindow", Text="×", Dock=DockStyle.Right, Width=42, AccessibleName="关闭窗口" }; close.Click+=(_,_)=>Close();
        var minimize=new MenuButton { Text="−", Dock=DockStyle.Right, Width=42, AccessibleName="最小化" }; minimize.Click+=(_,_)=>Hide();
        chrome.Controls.Add(caption);chrome.Controls.Add(minimize);chrome.Controls.Add(close);
        caption.MouseDown+=(_,e)=> { if(e.Button==MouseButtons.Left) { Native.ReleaseCapture();Native.SendMessage(Handle,0x00A1,new IntPtr(2),IntPtr.Zero); } };
        root.Controls.Add(chrome,0,0);
        var content=new TableLayoutPanel { Dock=DockStyle.Fill,ColumnCount=3,RowCount=1,Padding=new Padding(24,10,24,0) };
        content.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute,250));content.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute,30));content.ColumnStyles.Add(new ColumnStyle(SizeType.Percent,100));
        var sidebar=new TableLayoutPanel { Dock=DockStyle.Fill,ColumnCount=1,RowCount=7,Padding=new Padding(0,0,0,8) };
        sidebar.RowStyles.Add(new RowStyle(SizeType.Absolute,95));sidebar.RowStyles.Add(new RowStyle(SizeType.Absolute,42));sidebar.RowStyles.Add(new RowStyle(SizeType.Absolute,160));sidebar.RowStyles.Add(new RowStyle(SizeType.Absolute,30));sidebar.RowStyles.Add(new RowStyle(SizeType.Absolute,54));sidebar.RowStyles.Add(new RowStyle(SizeType.Absolute,54));sidebar.RowStyles.Add(new RowStyle(SizeType.Percent,100));
        var logo=new PictureBox { Name="BrandWordmark", Image=Palette.Image("wordmark.png"),Dock=DockStyle.Fill,SizeMode=PictureBoxSizeMode.Zoom,AccessibleName="ZFSN 定制标志",Margin=new Padding(0) };
        Disposed+=(_,_)=>logo.Image?.Dispose();sidebar.Controls.Add(logo,0,0);
        sidebar.Controls.Add(new Label { Text="PERSONAL POINTER SYSTEM",Font=new Font("Consolas",8),ForeColor=Palette.Muted,Dock=DockStyle.Fill,TextAlign=ContentAlignment.TopCenter },0,1);
        preview.Dock=DockStyle.Fill;preview.Margin=new Padding(0);sidebar.Controls.Add(preview,0,2);
        sidebar.Controls.Add(new Label {Text="光标效果示意 · 移入此处预览",ForeColor=Palette.Muted,Font=new Font(Font.FontFamily,8),Dock=DockStyle.Fill,TextAlign=ContentAlignment.MiddleCenter},0,3);
        var visualNav=new MenuButton { Name="VisualTab",Text="01    视觉效果",Selected=true,Dock=DockStyle.Fill,Margin=new Padding(0,5,0,5) };
        var systemNav=new MenuButton { Name="SystemTab",Text="02    启动与窗口",Dock=DockStyle.Fill,Margin=new Padding(0,5,0,5) };
        sidebar.Controls.Add(visualNav,0,4);sidebar.Controls.Add(systemNav,0,5);
        sidebar.Controls.Add(new Label {Text="CURSOR STUDIO  /  1.2\n设置实时生效 · 自动保存",ForeColor=Palette.Muted,Font=new Font(Font.FontFamily,8),Dock=DockStyle.Fill,TextAlign=ContentAlignment.BottomLeft},0,6);
        content.Controls.Add(sidebar,0,0);
        var pages=new Panel { Dock=DockStyle.Fill };content.Controls.Add(pages,2,0);
        TableLayoutPanel Page(string title,string subtitle)
        {
            var page=new TableLayoutPanel {Dock=DockStyle.Fill,ColumnCount=1,RowCount=6,Margin=new Padding(0)};
            page.ColumnStyles.Add(new ColumnStyle(SizeType.Percent,100));
            page.RowStyles.Add(new RowStyle(SizeType.Absolute,70));
            page.RowStyles.Add(new RowStyle(SizeType.Absolute,84));page.RowStyles.Add(new RowStyle(SizeType.Absolute,84));page.RowStyles.Add(new RowStyle(SizeType.Absolute,84));
            page.RowStyles.Add(new RowStyle(SizeType.Percent,100));page.RowStyles.Add(new RowStyle(SizeType.Absolute,44));
            var heading=new Panel {Dock=DockStyle.Fill};
            heading.Controls.Add(new Label {Text=subtitle,ForeColor=Palette.Muted,Font=new Font(Font.FontFamily,9),Dock=DockStyle.Bottom,Height=27});
            heading.Controls.Add(new Label {Text=title,ForeColor=Palette.Text,Font=new Font(Font.FontFamily,23,FontStyle.Bold),Dock=DockStyle.Top,Height=40});
            page.Controls.Add(heading,0,0);pages.Controls.Add(page);return page;
        }
        var visual=Page("让每次移动，都有风格。","定制你的指针与拖尾，保留熟悉的操作手感。");
        var system=Page("按你的习惯，随时就绪。","管理登录启动与托盘行为，让光标融入日常。");
        OptionToggle Option(TableLayoutPanel page,int row,string name,string text,string description,bool value)
        { var box=new OptionToggle {Name=name,Text=text,Description=description,Checked=value};page.Controls.Add(box,0,row);return box; }
        replace=Option(visual,1,"ReplaceCursor","网站同款指针","箭头与链接圆环，使用网站原始图形。",settings.ReplaceCursor);
        halo=Option(visual,2,"ShowHalo","跟随光晕","柔和的红色光晕，随鼠标移动。",settings.ShowHalo);
        pause=Option(visual,3,"PauseFullscreen","全屏时暂停特效","游戏或视频全屏时，暂时隐藏拖尾与光晕。",settings.PauseFullscreen);
        var strength=new TableLayoutPanel {Dock=DockStyle.Fill,ColumnCount=1,RowCount=3,BackColor=Palette.Panel,Padding=new Padding(16,8,16,8),Margin=new Padding(0,4,0,12)};
        strength.RowStyles.Add(new RowStyle(SizeType.Absolute,27));strength.RowStyles.Add(new RowStyle(SizeType.Percent,100));strength.RowStyles.Add(new RowStyle(SizeType.Absolute,20));
        intensityLabel=new Label {Dock=DockStyle.Fill,ForeColor=Palette.Text,TextAlign=ContentAlignment.MiddleLeft};strength.Controls.Add(intensityLabel,0,0);
        intensity=new IntensitySlider {Name="Intensity",Value=settings.Intensity,Dock=DockStyle.Fill};strength.Controls.Add(intensity,0,1);
        strength.Controls.Add(new Label {Text="轻盈                                            鲜明",ForeColor=Palette.Muted,Font=new Font(Font.FontFamily,8),Dock=DockStyle.Fill},0,2);visual.Controls.Add(strength,0,4);
        var defaults=new MenuButton {Text="↺  恢复特效默认值",Dock=DockStyle.Left,Width=190};defaults.Click+=(_,_)=>{replace.Checked=true;halo.Checked=true;pause.Checked=true;intensity.Value=100;};visual.Controls.Add(defaults,0,5);
        bool registered=false;try {registered=StartupRegistration.Enabled;}catch{}
        startup=Option(system,1,"WindowsStartup","开机自启动","登录 Windows 后启用光标，并安静留在托盘。",registered);
        launch=Option(system,2,"LaunchEffects","打开软件时启用光标","手动启动程序时，直接开启已保存的效果。",settings.StartEffects);
        closeToTray=Option(system,3,"CloseToTray","关闭时保留在托盘","关闭设置窗口后，光标继续运行。",settings.CloseToTray);
        system.Controls.Add(new Label {Text="设置自动保存在此用户的本地目录。\n\n自启动启用后请保持程序位置不变；移动程序后，\n取消并重新开启自启动即可更新路径。",ForeColor=Palette.Muted,Dock=DockStyle.Fill,Padding=new Padding(10,20,0,0),Font=new Font(Font.FontFamily,9)},0,4);
        var folder=new MenuButton {Text="打开设置目录  ↗",Dock=DockStyle.Left,Width=190};folder.Click+=(_,_)=>{try{Directory.CreateDirectory(AppSettings.Folder);Process.Start(new ProcessStartInfo(AppSettings.Folder){UseShellExecute=true});}catch(Exception e){Error(e);}};system.Controls.Add(folder,0,5);
        void SelectPage(bool first){visual.Visible=first;system.Visible=!first;if(first)visual.BringToFront();else system.BringToFront();visualNav.Selected=first;systemNav.Selected=!first;visualNav.Invalidate();systemNav.Invalidate();}
        visualNav.Click+=(_,_)=>SelectPage(true);systemNav.Click+=(_,_)=>SelectPage(false);SelectPage(true);
        root.Controls.Add(content,0,1);
        var footer=new TableLayoutPanel {Dock=DockStyle.Fill,ColumnCount=4,RowCount=1,Padding=new Padding(26,24,26,18)};
        footer.ColumnStyles.Add(new ColumnStyle(SizeType.Percent,100));footer.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute,200));footer.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute,124));footer.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute,116));
        status.Font=new Font(Font.FontFamily,8.5f);status.TextAlign=ContentAlignment.MiddleLeft;footer.Controls.Add(status,0,0);
        toggle.Primary=true;toggle.Dock=DockStyle.Fill;footer.Controls.Add(toggle,1,0);
        var hide=new MenuButton {Text="隐藏到托盘",Dock=DockStyle.Fill};hide.Click+=(_,_)=>Hide();footer.Controls.Add(hide,2,0);
        var quit=new MenuButton {Text="退出并恢复",Dock=DockStyle.Fill,ForeColor=Palette.Muted};quit.Click+=(_,_)=>ExitApp();footer.Controls.Add(quit,3,0);
        root.Controls.Add(footer,0,2);Controls.Add(root);
        root.Paint+=(_,e)=>{using var line=new Pen(Palette.Line);e.Graphics.DrawRectangle(line,0,0,root.Width-1,root.Height-1);};
        var menu = new ContextMenuStrip { BackColor = Palette.Panel, ForeColor = Palette.Text, ShowImageMargin = false, Renderer = new TrayRenderer() };
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
        settings.Intensity = intensity.Value; overlay.Intensity = intensity.Value / 100f;
        preview.Strength=overlay.Intensity;preview.Halo=halo.Checked;preview.WebCursor=replace.Checked;preview.Invalidate(); intensityLabel.Text = $"拖尾强度                                      {intensity.Value}%";
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
    protected override void WndProc(ref Message message)
    {
        base.WndProc(ref message);
        if(message.Msg!=0x0084 || WindowState!=FormWindowState.Normal || message.Result!=new IntPtr(1))return;
        long raw=message.LParam.ToInt64();var point=PointToClient(new Point((short)(raw&0xffff),(short)((raw>>16)&0xffff)));
        int edge=(int)(6*DeviceDpi/96f);bool left=point.X<edge,right=point.X>=ClientSize.Width-edge,top=point.Y<edge,bottom=point.Y>=ClientSize.Height-edge;
        int hit=top?(left?13:right?14:12):bottom?(left?16:right?17:15):left?10:right?11:1;
        message.Result=new IntPtr(hit);
    }
    protected override void Dispose(bool disposing)
    { if (disposing) { overlay.Dispose(); scheme.Dispose(); tray.Visible = false; tray.Dispose(); } base.Dispose(disposing); }
}
