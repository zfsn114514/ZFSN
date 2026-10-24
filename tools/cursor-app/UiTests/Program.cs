using System.Reflection;
using ZfsnCursor;
internal static class Program
{
    [STAThread]
    static void Main(string[] args)
    {
        Application.SetHighDpiMode(HighDpiMode.PerMonitorV2);Application.EnableVisualStyles();Application.SetCompatibleTextRenderingDefault(false);
        using var window=new SettingsWindow(false);window.Show();Application.DoEvents();
        var all=Descendants(window).ToArray();
        T Find<T>(string name) where T:Control => (T)all.Single(x=>x.Name==name);
        Check(all.OfType<TrackBar>().Count()==0,"no native trackbars");
        Check(all.OfType<CheckBox>().All(x=>x is OptionToggle),"every checkbox uses custom toggle rendering");
        Check(all.OfType<ScrollableControl>().All(x=>!x.AutoScroll),"layout requires no native scrollbars");
        Check(Find<PictureBox>("BrandWordmark").Image?.Width==1400,"website wordmark is embedded at full resolution");
        var option=Find<OptionToggle>("ShowHalo");bool initial=option.Checked;
        typeof(CheckBox).GetMethod("OnClick",BindingFlags.Instance|BindingFlags.NonPublic)!.Invoke(option,new object[]{EventArgs.Empty});
        Check(option.Checked!=initial,"custom switch click updates checked state");option.Checked=initial;
        var slider=Find<IntensitySlider>("Intensity");slider.Value=42;
        typeof(IntensitySlider).GetMethod("OnKeyDown",BindingFlags.Instance|BindingFlags.NonPublic)!.Invoke(slider,new object[]{new KeyEventArgs(Keys.Right)});
        Check(slider.Value==47,"custom slider supports keyboard adjustment");slider.Value=100;
        string folder=args.Length>0?args[0]:"ui-previews";Directory.CreateDirectory(folder);
        Capture(window,Path.Combine(folder,"visual.png"));
        Find<MenuButton>("SystemTab").PerformClick();Application.DoEvents();
        Check(Find<OptionToggle>("WindowsStartup").Visible,"system tab reveals startup controls");Capture(window,Path.Combine(folder,"system.png"));
        Find<MenuButton>("VisualTab").PerformClick();window.Size=window.MinimumSize;Application.DoEvents();
        Check(slider.Visible,"visual tab restores controls at minimum size");
        foreach(var control in Descendants(window).Where(c=>c.Visible&&c.Parent is TableLayoutPanel))
            Check(control.Bounds.Right<=control.Parent!.ClientSize.Width+1 && control.Bounds.Bottom<=control.Parent.ClientSize.Height+1,"layout bounds: "+control.GetType().Name);
        Capture(window,Path.Combine(folder,"compact.png"));
        Console.WriteLine("PASS WinForms rendering and UI interaction checks");window.Hide();
    }
    static IEnumerable<Control> Descendants(Control parent){foreach(Control child in parent.Controls){yield return child;foreach(var next in Descendants(child))yield return next;}}
    static void Check(bool condition,string message){if(!condition)throw new Exception(message);Console.WriteLine("PASS "+message);}
    static void Capture(Form window,string path){Application.DoEvents();using var bitmap=new Bitmap(window.Width,window.Height);window.DrawToBitmap(bitmap,window.ClientRectangle);bitmap.Save(path,System.Drawing.Imaging.ImageFormat.Png);}
}
