using System.Drawing.Drawing2D;
namespace ZfsnCursor;

internal static class Palette
{
    public static readonly Color Background = Color.FromArgb(7, 13, 22), Panel = Color.FromArgb(33, 16, 26), Red = Color.FromArgb(255, 100, 99), Yellow = Color.FromArgb(245, 231, 69), Cyan = Color.FromArgb(113, 221, 225), Text = Color.FromArgb(220, 233, 234);
}
internal sealed class MenuButton : Button
{
    bool hover;
    public MenuButton()
    {
        FlatStyle = FlatStyle.Flat; FlatAppearance.BorderSize = 0; BackColor = Palette.Panel; ForeColor = Palette.Red;
        Cursor = Cursors.Hand; Height = 43; Width = 160; Margin = new Padding(0, 5, 12, 5);
        SetStyle(ControlStyles.UserPaint | ControlStyles.OptimizedDoubleBuffer, true);
    }
    protected override void OnMouseEnter(EventArgs e) { hover = true; Invalidate(); base.OnMouseEnter(e); }
    protected override void OnMouseLeave(EventArgs e) { hover = false; Invalidate(); base.OnMouseLeave(e); }
    protected override void OnGotFocus(EventArgs e) { Invalidate(); base.OnGotFocus(e); }
    protected override void OnLostFocus(EventArgs e) { Invalidate(); base.OnLostFocus(e); }
    protected override void OnPaint(PaintEventArgs e)
    {
        var g = e.Graphics; g.Clear(BackColor);
        Color color = hover || Focused ? Palette.Yellow : ForeColor;
        using var pen = new Pen(color);
        g.DrawPolygon(pen, new Point[] { new(0,0), new(Width-1,0), new(Width-1,Height-12), new(Width-12,Height-1), new(0,Height-1) });
        TextRenderer.DrawText(g, Text, Font, ClientRectangle, color, TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter);
    }
}
internal sealed class HeaderPanel : Panel
{
    public HeaderPanel() { DoubleBuffered = true; BackColor = Palette.Panel; }
    protected override void OnPaint(PaintEventArgs e)
    {
        base.OnPaint(e);
        using var pen = new Pen(Palette.Yellow, 2);
        e.Graphics.DrawLine(pen, 0, 0, 0, Height);
        using var lines = new Pen(Color.FromArgb(35, Palette.Red));
        for (int y=0; y<Height; y+=4) e.Graphics.DrawLine(lines, Width-180, y, Width, y);
    }
}
