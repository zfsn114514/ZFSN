using System.Diagnostics;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
namespace ZfsnCursor;

internal sealed class TrailOverlay : Form
{
    readonly TrailModel model = new();
    readonly System.Windows.Forms.Timer timer = new() { Interval = 16 };
    readonly Stopwatch watch = new();
    readonly Bitmap sprite = MakeSprite();
    readonly Bitmap halo = MakeHalo();
    double? haloX, haloY;
    double monitorScale = 1;
    public bool ShowHalo { get; set; } = true;
    double lastSeconds;
    public bool PauseFullscreen { get; set; } = true;
    public float Intensity { get; set; } = 1;
    public event Action<Exception>? Failed;
    public TrailOverlay()
    {
        FormBorderStyle = FormBorderStyle.None; ShowInTaskbar = false; TopMost = true;
        StartPosition = FormStartPosition.Manual; Bounds = new Rectangle(-100, -100, 1, 1);
        timer.Tick += (_, _) => TickFrame();
    }
    protected override bool ShowWithoutActivation => true;
    protected override CreateParams CreateParams
    {
        get { var value = base.CreateParams; value.ExStyle |= 0x00080000 | 0x00000020 | 0x00000080 | 0x08000000; return value; }
    }
    protected override void WndProc(ref Message message)
    {
        if (message.Msg == 0x0084) { message.Result = new IntPtr(-1); return; }
        base.WndProc(ref message);
    }
    public void StartEffects() { model.Clear(); haloX = haloY = null; watch.Restart(); lastSeconds = 0; timer.Start(); }
    public void StopEffects() { timer.Stop(); model.Clear(); haloX = haloY = null; Hide(); }
    void TickFrame()
    {
        try
        {
            double now = watch.Elapsed.TotalSeconds, seconds = now - lastSeconds; lastSeconds = now;
            var info = new Native.CURSORINFO { Size = Marshal.SizeOf<Native.CURSORINFO>() };
            if (!Native.GetCursorPos(out var cursor) || !Native.GetCursorInfo(ref info) || (info.Flags & 1) == 0 || (PauseFullscreen && Native.Fullscreen(cursor)))
            { model.Clear(); haloX = haloY = null; Hide(); return; }
            model.Step(seconds);
            monitorScale = Native.Scale(cursor);
            model.Move(cursor.X, cursor.Y, monitorScale);
            double factor = 1 - Math.Pow(.88, Math.Clamp(seconds, 0, .1) * 60);
            haloX = haloX.HasValue ? haloX.Value + (cursor.X - haloX.Value) * factor : cursor.X;
            haloY = haloY.HasValue ? haloY.Value + (cursor.Y - haloY.Value) * factor : cursor.Y;
            if (model.Particles.Count == 0 && !ShowHalo) { Hide(); return; }
            RenderParticles();
        }
        catch (Exception error) { StopEffects(); Failed?.Invoke(error); }
    }
    void RenderParticles()
    {
        double minX = double.MaxValue, minY = minX, maxX = double.MinValue, maxY = maxX;
        foreach (var particle in model.Particles)
        {
            double radius = particle.Radius * particle.Life * 3.4 + 3;
            minX = Math.Min(minX, particle.X - radius); minY = Math.Min(minY, particle.Y - radius);
            maxX = Math.Max(maxX, particle.X + radius); maxY = Math.Max(maxY, particle.Y + radius);
        }
        if (ShowHalo && haloX.HasValue && haloY.HasValue)
        {
            double radius = 310 * monitorScale;
            minX = Math.Min(minX, haloX.Value - radius); minY = Math.Min(minY, haloY.Value - radius);
            maxX = Math.Max(maxX, haloX.Value + radius); maxY = Math.Max(maxY, haloY.Value + radius);
        }
        int left = (int)Math.Floor(minX), top = (int)Math.Floor(minY);
        int width = Math.Max(1, (int)Math.Ceiling(maxX) - left), height = Math.Max(1, (int)Math.Ceiling(maxY) - top);
        using var image = new Bitmap(width, height, PixelFormat.Format32bppPArgb);
        using (var graphics = Graphics.FromImage(image))
        {
            graphics.Clear(Color.Transparent);
            graphics.CompositingMode = CompositingMode.SourceOver;
            graphics.InterpolationMode = InterpolationMode.HighQualityBilinear;
            if (ShowHalo && haloX.HasValue && haloY.HasValue)
            {
                int diameter = (int)(620 * monitorScale);
                using var attributes = new ImageAttributes();
                attributes.SetColorMatrix(new ColorMatrix { Matrix33 = Intensity });
                graphics.DrawImage(halo, new Rectangle((int)(haloX.Value - diameter / 2d) - left, (int)(haloY.Value - diameter / 2d) - top, diameter, diameter), 0, 0, halo.Width, halo.Height, GraphicsUnit.Pixel, attributes);
            }
            foreach (var particle in model.Particles)
            {
                float radius = (float)(particle.Radius * particle.Life * 3.4);
                using var attributes = new ImageAttributes();
                attributes.SetColorMatrix(new ColorMatrix { Matrix33 = (float)particle.Life * Intensity });
                var rectangle = new Rectangle((int)(particle.X - radius) - left, (int)(particle.Y - radius) - top, Math.Max(1, (int)(radius * 2)), Math.Max(1, (int)(radius * 2)));
                graphics.DrawImage(sprite, rectangle, 0, 0, sprite.Width, sprite.Height, GraphicsUnit.Pixel, attributes);
            }
        }
        var screen = Native.GetDC(IntPtr.Zero);
        var memory = Native.CreateCompatibleDC(screen);
        var bitmap = image.GetHbitmap(Color.FromArgb(0));
        var previous = Native.SelectObject(memory, bitmap);
        try
        {
            var position = new Native.POINT(left, top); var size = new Native.SIZE(width, height); var source = new Native.POINT(0, 0);
            var blend = new Native.BLEND { Op = 0, Flags = 0, Alpha = 255, Format = 1 };
            if (!Visible) Show();
            if (!Native.UpdateLayeredWindow(Handle, screen, ref position, ref size, memory, ref source, 0, ref blend, 2)) throw new System.ComponentModel.Win32Exception();
        }
        finally { Native.SelectObject(memory, previous); Native.DeleteObject(bitmap); Native.DeleteDC(memory); Native.ReleaseDC(IntPtr.Zero, screen); }
    }
    static Bitmap MakeSprite()
    {
        const int size = 128;
        var image = new Bitmap(size, size, PixelFormat.Format32bppPArgb);
        var bytes = new byte[size * size * 4];
        for (int y = 0; y < size; y++) for (int x = 0; x < size; x++)
        {
            double distance = Math.Min(1, Math.Sqrt(Math.Pow((x + .5 - size / 2d) / (size / 2d), 2) + Math.Pow((y + .5 - size / 2d) / (size / 2d), 2)));
            double alpha, green, blue;
            if (distance <= .45) { double t = distance / .45; alpha = .5 + (.16 - .5) * t; green = 90 + (45 - 90) * t; blue = 115 + (74 - 115) * t; }
            else { alpha = .16 * (1 - (distance - .45) / .55); green = 45; blue = 74; }
            int index = (y * size + x) * 4;
            bytes[index] = (byte)(blue * alpha); bytes[index + 1] = (byte)(green * alpha); bytes[index + 2] = (byte)(255 * alpha); bytes[index + 3] = (byte)(255 * alpha);
        }
        var locked = image.LockBits(new Rectangle(0, 0, size, size), ImageLockMode.WriteOnly, PixelFormat.Format32bppPArgb);
        Marshal.Copy(bytes, 0, locked.Scan0, bytes.Length); image.UnlockBits(locked); return image;
    }
    static Bitmap MakeHalo()
    {
        const int size = 256;
        var image = new Bitmap(size, size, PixelFormat.Format32bppPArgb);
        var bytes = new byte[size * size * 4];
        for (int y = 0; y < size; y++) for (int x = 0; x < size; x++)
        {
            double distance = Math.Sqrt(Math.Pow(x + .5 - size / 2d, 2) + Math.Pow(y + .5 - size / 2d, 2)) / (size / 2d * Math.Sqrt(2));
            double alpha = distance <= .4 ? .14 + (.05 - .14) * distance / .4 : distance < .68 ? .05 * (1 - (distance - .4) / .28) : 0;
            int index = (y * size + x) * 4;
            bytes[index] = (byte)(74 * alpha); bytes[index + 1] = (byte)(45 * alpha); bytes[index + 2] = (byte)(255 * alpha); bytes[index + 3] = (byte)(255 * alpha);
        }
        var locked = image.LockBits(new Rectangle(0, 0, size, size), ImageLockMode.WriteOnly, PixelFormat.Format32bppPArgb);
        Marshal.Copy(bytes, 0, locked.Scan0, bytes.Length); image.UnlockBits(locked); return image;
    }
    protected override void Dispose(bool disposing)
    { if (disposing) { timer.Dispose(); sprite.Dispose(); halo.Dispose(); } base.Dispose(disposing); }
}
